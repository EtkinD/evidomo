import type { CookieOptions } from 'express';
import type { Env } from '../env.ts';
import type { RateLimit } from './rate-limit.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthConfig {
  /** The web app's origin; the only Origin allowed on state-changing requests. */
  appOrigin: string;
  cookie: {
    name: string;
    secure: boolean;
  };
  /** Absolute session lifetime (no sliding renewal). */
  sessionTtlMs: number;
  rateLimits: AuthRateLimits;
}

export interface AuthRateLimits {
  /** Every login attempt from one client IP. */
  loginPerIp: RateLimit;
  /** Login attempts for one email, from any IP; reset by a successful login. */
  loginPerAccount: RateLimit;
  /** Every registration attempt from one client IP. */
  registerPerIp: RateLimit;
}

// Generous enough for a room of people behind one NAT (a demo venue), tight enough to make
// online password guessing impractical: 10 guesses per account per 15 minutes.
export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  loginPerIp: { limit: 50, windowMs: 15 * 60 * 1000 },
  loginPerAccount: { limit: 10, windowMs: 15 * 60 * 1000 },
  registerPerIp: { limit: 20, windowMs: 60 * 60 * 1000 },
};

const COOKIE_BASE_NAME = 'evidomo_session';

export function authConfigFromEnv(
  env: Pick<Env, 'APP_ORIGIN' | 'SESSION_TTL_DAYS'>,
  rateLimits: AuthRateLimits = DEFAULT_AUTH_RATE_LIMITS,
): AuthConfig {
  // An https origin means the browser talks TLS to Caddy: the cookie gets Secure and the
  // `__Host-` prefix, which pins it to this exact host with Path=/ and no Domain attribute.
  // Plain http (development, a local run of the production stack) cannot carry either.
  const secure = new URL(env.APP_ORIGIN).protocol === 'https:';
  return {
    appOrigin: env.APP_ORIGIN,
    cookie: {
      name: secure ? `__Host-${COOKIE_BASE_NAME}` : COOKIE_BASE_NAME,
      secure,
    },
    sessionTtlMs: env.SESSION_TTL_DAYS * DAY_MS,
    rateLimits,
  };
}

function baseCookieOptions(config: AuthConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookie.secure,
    path: '/',
  };
}

export function sessionCookieOptions(config: AuthConfig): CookieOptions {
  return { ...baseCookieOptions(config), maxAge: config.sessionTtlMs };
}

/** Must match the attributes the cookie was set with, or browsers keep the old cookie. */
export function clearSessionCookieOptions(config: AuthConfig): CookieOptions {
  return baseCookieOptions(config);
}

/**
 * The value of cookie `name` from a Cookie header, or undefined. Parsed by hand to avoid a
 * cookie-parser dependency for a single cookie. The first occurrence wins, matching browsers,
 * which send the most specific (longest path) cookie first.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    // Our tokens are base64url and never quoted or percent-encoded; anything else is rejected
    // later by the token format check.
    return raw;
  }
  return undefined;
}
