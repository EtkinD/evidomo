import type { Request, RequestHandler, Response } from 'express';
import type { ApiError, AuthUser } from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { deleteSession, getValidSession } from '../db/repositories/users.ts';
import { clearSessionCookieOptions, readCookie, type AuthConfig } from './config.ts';
import { hashSessionToken, isWellFormedSessionToken } from './tokens.ts';

interface SessionContext {
  user: AuthUser;
  tokenHash: string;
}

// Per-request auth state, keyed by the request object, instead of an untyped property bolted
// onto Express's Request. Entries disappear with the request.
const attached = new WeakMap<Request, SessionContext>();
const pending = new WeakMap<Request, Promise<SessionContext | null>>();

/**
 * The signed-in user on a route mounted behind `requireUser`. Throws on a route without it:
 * that is a wiring bug, and failing loudly (500) beats treating the request as anonymous.
 */
export function currentUser(req: Request): AuthUser {
  const context = attached.get(req);
  if (context === undefined) {
    throw new Error('currentUser() called on a route that is not behind requireUser');
  }
  return context.user;
}

/** The signed-in user if `loadUser` or `requireUser` found a valid session, else undefined. */
export function optionalUser(req: Request): AuthUser | undefined {
  return attached.get(req)?.user;
}

/**
 * The hash of whatever well-formed session token the request presents, valid or not. Used to
 * delete the presented session on logout and on login (session rotation).
 */
export function presentedTokenHash(req: Request, config: AuthConfig): string | undefined {
  const token = readCookie(req.headers.cookie, config.cookie.name);
  if (token === undefined || !isWellFormedSessionToken(token)) return undefined;
  return hashSessionToken(token);
}

export interface SessionMiddleware {
  /** Attaches the user when the request carries a valid session; never rejects the request. */
  loadUser: RequestHandler;
  /** Responds 401 `{ error: 'unauthenticated' }` unless the request carries a valid session. */
  requireUser: RequestHandler;
}

export function createSessionMiddleware(deps: {
  db: Executor;
  config: AuthConfig;
}): SessionMiddleware {
  const { db, config } = deps;

  async function lookup(req: Request, res: Response): Promise<SessionContext | null> {
    const token = readCookie(req.headers.cookie, config.cookie.name);
    if (token === undefined) return null;
    if (!isWellFormedSessionToken(token)) {
      res.clearCookie(config.cookie.name, clearSessionCookieOptions(config));
      return null;
    }

    const tokenHash = hashSessionToken(token);
    const found = await getValidSession(db, tokenHash);
    if (found === undefined) {
      // Expired (or already deleted): remove the row now rather than waiting for the next
      // sweep, and tell the browser to drop the cookie.
      await deleteSession(db, tokenHash);
      res.clearCookie(config.cookie.name, clearSessionCookieOptions(config));
      return null;
    }

    const context: SessionContext = {
      user: { id: found.user.id, email: found.user.email },
      tokenHash,
    };
    attached.set(req, context);
    return context;
  }

  // loadUser and requireUser may both run on one request; the session is looked up once.
  function resolve(req: Request, res: Response): Promise<SessionContext | null> {
    let promise = pending.get(req);
    if (promise === undefined) {
      promise = lookup(req, res);
      pending.set(req, promise);
    }
    return promise;
  }

  return {
    async loadUser(req, res, next) {
      await resolve(req, res);
      next();
    },
    async requireUser(req, res, next) {
      const context = await resolve(req, res);
      if (context === null) {
        res.status(401).json({ error: 'unauthenticated' } satisfies ApiError);
        return;
      }
      next();
    },
  };
}
