import { parseOptions } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_HASH_OPTIONS,
  hashPassword,
  normalizePassword,
  verifyAgainstDummy,
  verifyPassword,
} from './password.ts';

describe('password hashing', () => {
  it('produces an argon2id hash with the configured parameters and a random salt', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first.startsWith('$argon2id$')).toBe(true);
    expect(first).not.toBe(second);
    expect(parseOptions(first)).toMatchObject({
      memoryCost: PASSWORD_HASH_OPTIONS.memoryCost,
      timeCost: PASSWORD_HASH_OPTIONS.timeCost,
      parallelism: PASSWORD_HASH_OPTIONS.parallelism,
      saltLen: 16,
    });
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse battery stapler')).toBe(false);
  });

  it('treats canonically equivalent Unicode input as the same password', async () => {
    const composed = 'café au lait 1234';
    const decomposed = 'café au lait 1234';
    const stored = await hashPassword(composed);

    expect(normalizePassword(decomposed)).toBe(normalizePassword(composed));
    expect(await verifyPassword(stored, decomposed)).toBe(true);
  });

  it('throws on a stored hash that cannot be decoded instead of reporting a mismatch', async () => {
    await expect(verifyPassword('not-a-hash', 'whatever')).rejects.toThrow();
  });

  it('runs a dummy verification without throwing', async () => {
    await expect(verifyAgainstDummy('any password at all')).resolves.toBeUndefined();
  });
});
