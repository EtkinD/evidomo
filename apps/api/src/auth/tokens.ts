import { createHash, randomBytes } from 'node:crypto';

const SESSION_TOKEN_BYTES = 32;
// base64url of 32 bytes, unpadded: 43 characters.
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh session token. It only ever lives in the cookie; the database stores its hash. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256 (hex) of a session token. A fast hash is sufficient: the token has 256 bits of
 * entropy, so the hash cannot be brute-forced back, and a leaked `sessions` table yields no
 * usable cookies.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Rejects garbage cookie values before they reach the database. */
export function isWellFormedSessionToken(value: string): boolean {
  return SESSION_TOKEN_PATTERN.test(value);
}
