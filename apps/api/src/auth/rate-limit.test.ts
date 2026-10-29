import { describe, expect, it } from 'vitest';
import { createFixedWindowLimiter, ipRateLimitKey } from './rate-limit.ts';

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

    const resetAt = 1_000_000 + 60_000;
    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 1, windowResetAt: resetAt });
    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 0, windowResetAt: resetAt });
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
    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 0 });
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

  it('refunds a hit within the window it was counted in only', () => {
    const time = clock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1_000, now: time.now });

    const first = limiter.consume('a');
    if (!first.allowed) throw new Error('expected the first hit to pass');
    limiter.refund('a', first.windowResetAt);
    const second = limiter.consume('a');
    expect(second.allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);

    // A refund from an earlier window never frees a slot in the current one.
    time.advance(1_000);
    const current = limiter.consume('a');
    expect(current.allowed).toBe(true);
    if (second.allowed) limiter.refund('a', second.windowResetAt);
    expect(limiter.consume('a').allowed).toBe(false);
    // Refunding an unknown key or below zero is harmless.
    limiter.refund('missing', 0);
  });

  it('does not count refused hits, so a refund after refusals frees a real slot', () => {
    const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 60_000 });

    const first = limiter.consume('a');
    expect(limiter.consume('a').allowed).toBe(true);
    // Refused attempts while full must not pile up in the window.
    for (let i = 0; i < 5; i += 1) expect(limiter.consume('a').allowed).toBe(false);
    if (!first.allowed) throw new Error('expected the first hit to pass');
    // One allowed hit is taken back (e.g. that run start did not start a run): exactly one
    // slot is free again, so the user has the full limit of 2 successful hits.
    limiter.refund('a', first.windowResetAt);
    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume('a').allowed).toBe(false);
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

describe('ipRateLimitKey', () => {
  it('keeps IPv4 addresses whole, also when mapped into IPv6', () => {
    expect(ipRateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipRateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipRateLimitKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys IPv6 addresses by their /64 prefix, however they are written', () => {
    const key = '2001:db8:1:2::/64';
    for (const ip of [
      '2001:db8:1:2::1',
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '2001:0DB8:0001:0002:0000:0000:0000:0042',
      '2001:db8:1:2:a:b:1.2.3.4',
      '2001:db8:1:2::1%eth0',
    ]) {
      expect(ipRateLimitKey(ip), ip).toBe(key);
    }
    expect(ipRateLimitKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(ipRateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipRateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(ipRateLimitKey('fe80::1:2:3:4')).toBe('fe80:0:0:0::/64');
  });

  it('puts a missing or malformed address into one shared bucket', () => {
    for (const ip of [undefined, '', 'localhost', '1.2.3', '2001:db8:::1']) {
      expect(ipRateLimitKey(ip), String(ip)).toBe('unknown');
    }
  });

  it('makes one /64 share a limit while another /64 has its own', () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.consume(ipRateLimitKey('2001:db8:1:2::1')).allowed).toBe(true);
    expect(limiter.consume(ipRateLimitKey('2001:db8:1:2::9999')).allowed).toBe(false);
    expect(limiter.consume(ipRateLimitKey('2001:db8:1:3::1')).allowed).toBe(true);
  });
});
