import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// OWASP's minimum argon2id configuration, stated explicitly so a library default change cannot
// silently weaken new hashes. The algorithm is the library default (argon2id): selecting it
// would need the `Algorithm` const enum, which type stripping cannot erase. Tests assert the
// `$argon2id$` prefix and these parameters on a real hash. `verify` reads the parameters from
// the stored hash, so raising them later keeps old hashes verifiable.
export const PASSWORD_HASH_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Unicode-normalizes a password (NFKC, as NIST SP 800-63B recommends) so the same typed
 * characters always hash the same, whichever composition the client's keyboard produced.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export async function hashPassword(password: string): Promise<string> {
  return hash(normalizePassword(password), PASSWORD_HASH_OPTIONS);
}

/**
 * False for a wrong password. Throws when the stored hash cannot be decoded: that is corrupt
 * data, surfaced as a server error rather than disguised as a wrong password.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  return verify(storedHash, normalizePassword(password));
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same argon2 work as a real verification. Login calls it for an unknown email so
 * response timing does not reveal which addresses have accounts. The dummy hash is created
 * once, lazily, with the production parameters.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hash(randomBytes(32), PASSWORD_HASH_OPTIONS);
  await verifyPassword(await dummyHash, password);
}
