// In-process fixed-window rate limiter. The deployment runs a single API instance, so process
// memory is the whole picture and no shared store is needed. A restart resets all counters,
// which is acceptable for abuse throttling. Fixed windows allow up to 2x the limit across a
// window boundary; that is the price of O(1) memory per key.

import { isIPv4, isIPv6 } from 'node:net';

/**
 * The limiter key for a client IP: an IPv4 address as is, an IPv6 address as its /64 prefix
 * (`2001:db8:1:2::/64`). One IPv6 subscriber usually gets a whole /64 and can pick any address in
 * it, so per-address keys would hand out 2^64 buckets. IPv4-mapped IPv6 (`::ffff:192.0.2.1`)
 * counts as IPv4. Anything else (no address) shares one `unknown` bucket.
 */
export function ipRateLimitKey(ip: string | undefined): string {
  if (ip === undefined || ip === '') return 'unknown';
  if (isIPv4(ip)) return ip;
  const address = ip.split('%')[0] ?? ip; // drop a zone ID (`fe80::1%eth0`)
  if (!isIPv6(address)) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1] !== undefined && isIPv4(mapped[1])) return mapped[1];
  const [head = '', tail] = address.split('::');
  const groups = (part: string | undefined): string[] =>
    part === undefined || part === '' ? [] : part.split(':');
  const before = groups(head);
  // An embedded IPv4 tail (`::1.2.3.4`) spans two groups; it never reaches the first four.
  const after = groups(tail).flatMap((group) => (group.includes('.') ? ['0', '0'] : [group]));
  const missing = tail === undefined ? 0 : 8 - before.length - after.length;
  const full = [...before, ...Array.from({ length: missing }, () => '0'), ...after];
  const prefix = full.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export type RateLimitDecision =
  | {
      allowed: true;
      remaining: number;
      /** Identifies the window the hit was counted in, for `refund`. */
      windowResetAt: number;
    }
  | { allowed: false; retryAfterSeconds: number };

export interface FixedWindowLimiter {
  /** Counts one hit for `key` and decides whether it is within the limit. */
  consume(key: string): RateLimitDecision;
  /** Forgets `key`, e.g. after a successful login. */
  reset(key: string): void;
  /**
   * Takes back one allowed hit, e.g. a run start that did not start a run. Only counts in the
   * window the hit was made in (`windowResetAt` from its decision); a later window is untouched.
   */
  refund(key: string, windowResetAt: number): void;
  /** Number of tracked keys (for tests and diagnostics). */
  size(): number;
}

export interface FixedWindowLimiterOptions extends RateLimit {
  now?: () => number;
  /**
   * Upper bound on tracked keys. When reached, expired windows are swept; if the map is still
   * full, the oldest windows are evicted. Eviction under a flood of distinct keys can let an
   * evicted key start over, which beats unbounded memory or failing closed for everyone.
   */
  maxKeys?: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export function createFixedWindowLimiter(options: FixedWindowLimiterOptions): FixedWindowLimiter {
  const { limit, windowMs, now = Date.now, maxKeys = DEFAULT_MAX_KEYS } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer');
  }
  if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError('maxKeys must be a positive integer');
  }

  const windows = new Map<string, Window>();

  function makeRoom(at: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
    // Map iteration is insertion order, so this evicts the oldest windows first.
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) break;
      windows.delete(key);
    }
  }

  return {
    consume(key) {
      const at = now();
      let window = windows.get(key);
      if (window === undefined || window.resetAt <= at) {
        windows.delete(key);
        if (windows.size >= maxKeys) makeRoom(at);
        window = { count: 0, resetAt: at + windowMs };
        windows.set(key, window);
      }
      // A refused hit is not counted: the window holds allowed hits only, so a `refund` always
      // frees exactly one of them (a counted refusal would eat the refunded slot).
      if (window.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - at) / 1000)),
        };
      }
      window.count += 1;
      return { allowed: true, remaining: limit - window.count, windowResetAt: window.resetAt };
    },
    reset(key) {
      windows.delete(key);
    },
    refund(key, windowResetAt) {
      const window = windows.get(key);
      if (window !== undefined && window.resetAt === windowResetAt && window.count > 0) {
        window.count -= 1;
      }
    },
    size() {
      return windows.size;
    },
  };
}
