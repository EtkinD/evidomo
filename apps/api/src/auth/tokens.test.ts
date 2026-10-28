import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken, isWellFormedSessionToken } from './tokens.ts';

describe('session tokens', () => {
  it('generates 32 random bytes as unpadded base64url', () => {
    const token = generateSessionToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateSessionToken()).not.toBe(token);
  });

  it('hashes a token with SHA-256 to lower-case hex, deterministically', () => {
    const token = generateSessionToken();
    const expected = createHash('sha256').update(token).digest('hex');

    expect(hashSessionToken(token)).toBe(expected);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it('accepts only well-formed tokens', () => {
    expect(isWellFormedSessionToken(generateSessionToken())).toBe(true);
    for (const value of ['', 'short', `${'a'.repeat(43)}=`, `${'a'.repeat(42)}+`, 'a'.repeat(44)]) {
      expect(isWellFormedSessionToken(value)).toBe(false);
    }
  });
});
