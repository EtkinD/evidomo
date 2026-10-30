import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { startRunRequestSchema } from '@evidomo/shared';
import { createFixedWindowLimiter, ipRateLimitKey, type RateLimit } from '../auth/rate-limit.ts';
import { currentUser } from '../auth/session.ts';
import type { Env } from '../env.ts';
import { sendError, sendValidationError } from '../http/errors.ts';
import type { Logger } from '../logger.ts';

// Live-run access control (P4-10, docs/architecture.md §8 "Start a run" and §14): the guards
// `AppProjectDeps.runStartGuards` runs after `requireUser` and before the run start handler and
// the run resume handler (P5-03; a resume spends live model credit like a start). One guard array
// is mounted on both routes, so starts and resumes share the limiters and the allowance.
// 1. The access code (only when `LIVE_RUN_ACCESS_CODE` is configured): a missing or wrong code is
//    403 `access_code_invalid`; wrong codes are limited per client IP, so the code cannot be
//    guessed online.
// 2. Run starts per account and per client IP (429 `run_limit_reached`). Only requests that
//    actually put a run to work (a 2xx: 201 for a start, 200 for a resume) count: a hit is
//    reserved before the handler runs and refunded when the response is anything else
//    (`not_ready`, `run_active`, `run_not_resumable`, `daily_budget_reached`, …).
// The global daily budget cap stays in the handlers themselves (`daily_budget_reached`).

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RunStartLimits {
  /** Run starts and resumes (2xx) per account. */
  readonly perAccount: RateLimit;
  /** Run starts and resumes (2xx) per client IP, across accounts. */
  readonly perIp: RateLimit;
  /** Wrong access codes per client IP. */
  readonly accessCodeFailuresPerIp: RateLimit;
}

export function runStartLimitsFromEnv(
  env: Pick<
    Env,
    | 'RUN_STARTS_PER_ACCOUNT_PER_DAY'
    | 'RUN_STARTS_PER_IP_PER_DAY'
    | 'ACCESS_CODE_FAILURES_PER_IP_PER_HOUR'
  >,
): RunStartLimits {
  return {
    perAccount: { limit: env.RUN_STARTS_PER_ACCOUNT_PER_DAY, windowMs: DAY_MS },
    perIp: { limit: env.RUN_STARTS_PER_IP_PER_DAY, windowMs: DAY_MS },
    accessCodeFailuresPerIp: { limit: env.ACCESS_CODE_FAILURES_PER_IP_PER_HOUR, windowMs: HOUR_MS },
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * A constant-time comparison against the configured code: both sides are hashed first, so the
 * comparison always covers 32 bytes and neither the code's length nor a matching prefix shows in
 * the timing. The code itself is kept only as its hash.
 */
export function createAccessCodeMatcher(code: string): (candidate: string) => boolean {
  const expected = sha256(code);
  return (candidate) => timingSafeEqual(sha256(candidate), expected);
}

export interface RunStartGuardsDeps {
  /** `LIVE_RUN_ACCESS_CODE`; undefined turns the access code check off (development). */
  readonly accessCode: string | undefined;
  readonly limits: RunStartLimits;
  readonly logger: Logger;
  /** Clock for the limiters (tests). */
  readonly now?: () => number;
  /** The signed-in user's ID; defaults to `currentUser(req).id` (tests inject one). */
  readonly userIdOf?: (req: Request) => string;
}

type Limiter = 'run_start_account' | 'run_start_ip' | 'access_code_ip';

function clientIp(req: Request): string {
  // `req.ip` honours the narrowly configured `trust proxy` (one hop: Caddy), as the login limits;
  // IPv6 clients are keyed by their /64.
  return ipRateLimitKey(req.ip);
}

export function createRunStartGuards(deps: RunStartGuardsDeps): RequestHandler[] {
  const { logger, limits } = deps;
  const userIdOf = deps.userIdOf ?? ((req: Request) => currentUser(req).id);
  const clock = deps.now === undefined ? {} : { now: deps.now };
  const perAccount = createFixedWindowLimiter({ ...limits.perAccount, ...clock });
  const perIp = createFixedWindowLimiter({ ...limits.perIp, ...clock });
  const codeFailuresPerIp = createFixedWindowLimiter({
    ...limits.accessCodeFailuresPerIp,
    ...clock,
  });

  function rejectLimited(
    res: Response,
    userId: string,
    limiter: Limiter,
    retryAfterSeconds: number,
  ): void {
    // The IP (a limiter key) stays out of the log, as everywhere else.
    logger.warn({ userId, limiter }, 'run start rate limit exceeded');
    res.set('Retry-After', String(retryAfterSeconds));
    sendError(res, 429, limiter === 'access_code_ip' ? 'rate_limited' : 'run_limit_reached');
  }

  const guards: RequestHandler[] = [];

  if (deps.accessCode !== undefined) {
    const matches = createAccessCodeMatcher(deps.accessCode);
    guards.push((req, res, next) => {
      // The handler parses the body again; here only the access code matters, and a malformed
      // body is answered like the handler would (the issues never echo the submitted value).
      const body = startRunRequestSchema.safeParse(req.body ?? {});
      if (!body.success) {
        sendValidationError(res, body.error);
        return;
      }
      const userId = userIdOf(req);
      const code = body.data.accessCode;
      if (code === undefined) {
        // No guess was made, so a missing code does not count against the IP's attempts.
        logger.info({ userId }, 'run start refused: access code missing');
        sendError(res, 403, 'access_code_invalid');
        return;
      }
      // Counted before comparing, so a blocked IP learns nothing, not even from a right code.
      const ip = clientIp(req);
      const attempt = codeFailuresPerIp.consume(ip);
      if (!attempt.allowed) {
        rejectLimited(res, userId, 'access_code_ip', attempt.retryAfterSeconds);
        return;
      }
      if (!matches(code)) {
        logger.warn({ userId }, 'run start refused: wrong access code');
        sendError(res, 403, 'access_code_invalid');
        return;
      }
      // Only wrong codes are limited.
      codeFailuresPerIp.refund(ip, attempt.windowResetAt);
      next();
    });
  }

  guards.push((req, res, next) => {
    const userId = userIdOf(req);
    const ip = clientIp(req);
    const account = perAccount.consume(userId);
    const byIp = perIp.consume(ip);
    if (!account.allowed || !byIp.allowed) {
      if (account.allowed) perAccount.refund(userId, account.windowResetAt);
      if (byIp.allowed) perIp.refund(ip, byIp.windowResetAt);
      const retryAfterSeconds = Math.max(
        account.allowed ? 0 : account.retryAfterSeconds,
        byIp.allowed ? 0 : byIp.retryAfterSeconds,
      );
      rejectLimited(
        res,
        userId,
        account.allowed ? 'run_start_ip' : 'run_start_account',
        retryAfterSeconds,
      );
      return;
    }
    // A response that did not start or resume a run gives the reservation back. A client that
    // disconnects before the response finishes keeps it spent: the run may still have started.
    res.once('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) return;
      perAccount.refund(userId, account.windowResetAt);
      perIp.refund(ip, byIp.windowResetAt);
    });
    next();
  });

  return guards;
}
