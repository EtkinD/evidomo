import { createHash } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  loginRequestSchema,
  registerRequestSchema,
  type AuthUser,
  type AuthUserResponse,
} from '@evidomo/shared';
import type { Database, Executor } from '../db/client.ts';
import { EmailTakenError } from '../db/errors.ts';
import {
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  getUserByEmail,
} from '../db/repositories/users.ts';
import { errorForLog, sendError, sendValidationError } from '../http/errors.ts';
import { requireJsonBody } from '../http/guards.ts';
import type { Logger } from '../logger.ts';
import { clearSessionCookieOptions, sessionCookieOptions, type AuthConfig } from './config.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.ts';
import { createFixedWindowLimiter, ipRateLimitKey, type FixedWindowLimiter } from './rate-limit.ts';
import {
  currentUser,
  optionalUser,
  presentedTokenHash,
  type SessionMiddleware,
} from './session.ts';
import { generateSessionToken, hashSessionToken } from './tokens.ts';

export interface AuthRouterDeps {
  db: Database;
  config: AuthConfig;
  logger: Logger;
  session: SessionMiddleware;
}

type LimiterName = 'login_ip' | 'login_account' | 'register_ip';

/** Mounted at `/api/auth`: register, login, logout, me. */
export function createAuthRouter({ db, config, logger, session }: AuthRouterDeps): Router {
  const loginPerIp = createFixedWindowLimiter(config.rateLimits.loginPerIp);
  const loginPerAccount = createFixedWindowLimiter(config.rateLimits.loginPerAccount);
  const registerPerIp = createFixedWindowLimiter(config.rateLimits.registerPerIp);

  function rejectRateLimited(res: Response, name: LimiterName, retryAfterSeconds: number): void {
    // The limiter key (an IP or an email hash) stays out of the log.
    logger.warn({ limiter: name }, 'rate limit exceeded');
    res.set('Retry-After', String(retryAfterSeconds));
    sendError(res, 429, 'rate_limited');
  }

  function limitByIp(limiter: FixedWindowLimiter, name: LimiterName): RequestHandler {
    return (req, res, next) => {
      // `req.ip` honours the narrowly configured `trust proxy` (one hop: Caddy); IPv6 by /64.
      const decision = limiter.consume(ipRateLimitKey(req.ip));
      if (!decision.allowed) {
        rejectRateLimited(res, name, decision.retryAfterSeconds);
        return;
      }
      next();
    };
  }

  /**
   * Stores a fresh session, replacing whatever session the request presented (rotation: a
   * login never reuses a token). Returns the raw token for the cookie; call inside the
   * caller's transaction and set the cookie only after it commits.
   */
  async function issueSession(tx: Executor, req: Request, userId: string): Promise<string> {
    const token = generateSessionToken();
    const previous = presentedTokenHash(req, config);
    if (previous !== undefined) await deleteSession(tx, previous);
    await createSession(tx, {
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt: new Date(Date.now() + config.sessionTtlMs),
    });
    return token;
  }

  function setSessionCookie(res: Response, token: string): void {
    res.cookie(config.cookie.name, token, sessionCookieOptions(config));
  }

  async function sweepExpiredSessions(): Promise<void> {
    try {
      await deleteExpiredSessions(db);
    } catch (error) {
      // Cleanup is opportunistic: expired sessions are rejected on read regardless, so a
      // failed sweep must not fail the login that triggered it.
      logger.warn({ err: errorForLog(error) }, 'expired session sweep failed');
    }
  }

  function sendUser(res: Response, status: 200 | 201, user: AuthUser): void {
    res
      .status(status)
      .json({ user: { id: user.id, email: user.email } } satisfies AuthUserResponse);
  }

  const router = Router();
  // Responses carry identity and set cookies; no cache may keep them.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireJsonBody);

  router.post('/register', limitByIp(registerPerIp, 'register_ip'), async (req, res) => {
    const parsed = registerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    // Hashed before the insert, so a duplicate email costs the same time as a new one.
    const passwordHash = await hashPassword(parsed.data.password);
    let result: { user: AuthUser; token: string };
    try {
      // One transaction: an account never exists without the session that logs it in.
      result = await db.transaction(async (tx) => {
        const created = await createUser(tx, { email: parsed.data.email, passwordHash });
        return { user: created, token: await issueSession(tx, req, created.id) };
      });
    } catch (error) {
      if (error instanceof EmailTakenError) {
        sendError(res, 409, 'email_taken');
        return;
      }
      throw error;
    }

    const { user, token } = result;
    setSessionCookie(res, token);
    logger.info({ userId: user.id }, 'user registered');
    sendUser(res, 201, user);
  });

  router.post('/login', limitByIp(loginPerIp, 'login_ip'), async (req, res) => {
    const parsed = loginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const { email, password } = parsed.data;

    // Keyed by every submitted email, existing or not, so a 429 reveals nothing about which
    // accounts exist. Hashed so the limiter's memory holds no addresses.
    const accountKey = createHash('sha256').update(email).digest('hex');
    const accountDecision = loginPerAccount.consume(accountKey);
    if (!accountDecision.allowed) {
      rejectRateLimited(res, 'login_account', accountDecision.retryAfterSeconds);
      return;
    }

    const user = await getUserByEmail(db, email);
    let verified = false;
    if (user === undefined) {
      await verifyAgainstDummy(password);
    } else {
      verified = await verifyPassword(user.passwordHash, password);
    }
    if (user === undefined || !verified) {
      logger.info({ userId: user?.id }, 'login failed');
      sendError(res, 401, 'invalid_credentials');
      return;
    }

    loginPerAccount.reset(accountKey);
    const token = await db.transaction((tx) => issueSession(tx, req, user.id));
    setSessionCookie(res, token);
    await sweepExpiredSessions();
    logger.info({ userId: user.id }, 'user logged in');
    sendUser(res, 200, user);
  });

  // Idempotent and open to anonymous callers: it ends whatever session the cookie names.
  router.post('/logout', session.loadUser, async (req, res) => {
    const tokenHash = presentedTokenHash(req, config);
    if (tokenHash !== undefined) await deleteSession(db, tokenHash);
    res.clearCookie(config.cookie.name, clearSessionCookieOptions(config));
    const user = optionalUser(req);
    if (user !== undefined) logger.info({ userId: user.id }, 'user logged out');
    res.status(204).end();
  });

  router.get('/me', session.requireUser, (req, res) => {
    sendUser(res, 200, currentUser(req));
  });

  return router;
}
