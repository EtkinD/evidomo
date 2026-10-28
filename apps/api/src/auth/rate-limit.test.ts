import { describe, expect, it } from 'vitest';
import { createFixedWindowLimiter } from './rate-limit.ts';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('createFixedWindowLimiter', () => {
  it('allows up to the limit per window and then reports when to retry', () => {
    const time = clock();
    const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 60_000, now: time.now });

    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 1 });
    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 0 });
    time.advance(15_500);
    expect(limiter.consume('a')).toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it('keeps keys independent', () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1_000 });

    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
    expect(limiter.consume('b').allowed).toBe(true);
  });

  it('starts a new window once the previous one has elapsed', () => {
    const time = clock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1_000, now: time.now });

    limiter.consume('a');
    expect(limiter.consume('a').allowed).toBe(false);
    time.advance(1_000);
    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 0 });
  });

  it('never reports a Retry-After below one second', () => {
    const time = clock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1_000, now: time.now });

    limiter.consume('a');
    time.advance(999);
    expect(limiter.consume('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('forgets a key on reset', () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000 });

    limiter.consume('a');
    limiter.reset('a');
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('bounds memory by sweeping expired windows, then evicting the oldest', () => {
    const time = clock();
    const limiter = createFixedWindowLimiter({
      limit: 1,
      windowMs: 1_000,
      maxKeys: 3,
      now: time.now,
    });

    limiter.consume('old-1');
    limiter.consume('old-2');
    time.advance(1_000);
    limiter.consume('live-1');
    expect(limiter.size()).toBe(3);

    // Full: the two expired windows are swept first.
    limiter.consume('live-2');
    expect(limiter.size()).toBe(2);

    limiter.consume('live-3');
    // Still within the window and full: the oldest live key ('live-1') is evicted.
    limiter.consume('live-4');
    expect(limiter.size()).toBe(3);
    expect(limiter.consume('live-1').allowed).toBe(true);
    expect(limiter.consume('live-4').allowed).toBe(false);
  });

  it('rejects nonsensical configuration', () => {
    expect(() => createFixedWindowLimiter({ limit: 0, windowMs: 1_000 })).toThrow(RangeError);
    expect(() => createFixedWindowLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
    expect(() => createFixedWindowLimiter({ limit: 1, windowMs: 1, maxKeys: 0 })).toThrow(
      RangeError,
    );
  });
});
