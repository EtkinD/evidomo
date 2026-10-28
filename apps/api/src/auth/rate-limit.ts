// In-process fixed-window rate limiter. The deployment runs a single API instance, so process
// memory is the whole picture and no shared store is needed. A restart resets all counters,
// which is acceptable for abuse throttling. Fixed windows allow up to 2x the limit across a
// window boundary; that is the price of O(1) memory per key.

export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export type RateLimitDecision =
  { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number };

export interface FixedWindowLimiter {
  /** Counts one hit for `key` and decides whether it is within the limit. */
  consume(key: string): RateLimitDecision;
  /** Forgets `key`, e.g. after a successful login. */
  reset(key: string): void;
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
      window.count += 1;
      if (window.count > limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - at) / 1000)),
        };
      }
      return { allowed: true, remaining: limit - window.count };
    },
    reset(key) {
      windows.delete(key);
    },
    size() {
      return windows.size;
    },
  };
}
