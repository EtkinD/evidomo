import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { EmailTakenError, isUniqueViolation } from '../errors.ts';
import { sessions, users } from '../schema.ts';
import { returnedRow } from './rows.ts';

// Minimal account storage for P4-01; password hashing and token generation live in the auth
// module, so these functions only ever see the hash.

export type User = typeof users.$inferSelect;
export type PublicUser = Omit<User, 'passwordHash'>;
export type Session = typeof sessions.$inferSelect;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const publicUserColumns = {
  id: users.id,
  email: users.email,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

export async function createUser(
  db: Executor,
  input: { email: string; passwordHash: string },
): Promise<PublicUser> {
  try {
    const rows = await db
      .insert(users)
      .values({ email: normalizeEmail(input.email), passwordHash: input.passwordHash })
      .returning(publicUserColumns);
    return returnedRow(rows, 'user');
  } catch (error) {
    if (isUniqueViolation(error, 'users_email_lower_key')) throw new EmailTakenError();
    throw error;
  }
}

/** Includes the password hash: for credential checks only. */
export async function getUserByEmail(db: Executor, email: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, normalizeEmail(email)));
  return user;
}

export async function createSession(
  db: Executor,
  input: { tokenHash: string; userId: string; expiresAt: Date },
): Promise<Session> {
  return returnedRow(await db.insert(sessions).values(input).returning(), 'session');
}

/** Returns the session and its user, or undefined when missing or expired (by the DB clock). */
export async function getValidSession(
  db: Executor,
  tokenHash: string,
): Promise<{ session: Session; user: PublicUser } | undefined> {
  const [row] = await db
    .select({ session: sessions, user: publicUserColumns })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)));
  return row;
}

export async function deleteSession(db: Executor, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/** Returns the number of sessions removed. */
export async function deleteExpiredSessions(db: Executor): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, sql`now()`))
    .returning({ tokenHash: sessions.tokenHash });
  return deleted.length;
}
