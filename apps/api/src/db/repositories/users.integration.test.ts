import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmailTakenError } from '../errors.ts';
import { eq } from 'drizzle-orm';
import { projects, sessions, users } from '../schema.ts';
import { seedProject, startTestDatabase, type TestDatabase } from '../testing.ts';
import {
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  getUserByEmail,
  getValidSession,
} from './users.ts';

describe('users and sessions repository', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it('creates a user with a normalized email and never returns the hash from createUser', async () => {
    const user = await createUser(testDb.db, {
      email: '  Agent.One@Example.TEST ',
      passwordHash: 'hash-1',
    });

    expect(user.email).toBe('agent.one@example.test');
    expect(user).not.toHaveProperty('passwordHash');

    const found = await getUserByEmail(testDb.db, 'AGENT.ONE@example.test');
    expect(found?.id).toBe(user.id);
    expect(found?.passwordHash).toBe('hash-1');
  });

  it('rejects a second account for the same email regardless of case', async () => {
    await createUser(testDb.db, { email: 'dup@example.test', passwordHash: 'h' });

    await expect(
      createUser(testDb.db, { email: 'DUP@example.test', passwordHash: 'h' }),
    ).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('returns undefined for an unknown email', async () => {
    expect(await getUserByEmail(testDb.db, 'nobody@example.test')).toBeUndefined();
  });

  it('resolves a valid session to its user and ignores expired or deleted sessions', async () => {
    const user = await createUser(testDb.db, { email: 'sess@example.test', passwordHash: 'h' });
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    await createSession(testDb.db, { tokenHash: 'valid', userId: user.id, expiresAt: inOneHour });
    await createSession(testDb.db, { tokenHash: 'expired', userId: user.id, expiresAt: anHourAgo });

    const valid = await getValidSession(testDb.db, 'valid');
    expect(valid?.user).toEqual(user);
    expect(valid?.session.expiresAt).toEqual(inOneHour);
    expect(await getValidSession(testDb.db, 'expired')).toBeUndefined();

    expect(await deleteExpiredSessions(testDb.db)).toBeGreaterThanOrEqual(1);
    const remaining = await testDb.db.select({ tokenHash: sessions.tokenHash }).from(sessions);
    expect(remaining.map((s) => s.tokenHash)).not.toContain('expired');

    await deleteSession(testDb.db, 'valid');
    expect(await getValidSession(testDb.db, 'valid')).toBeUndefined();
  });

  it('hard-deletes a user together with their sessions and projects', async () => {
    const user = await createUser(testDb.db, { email: 'gone@example.test', passwordHash: 'h' });
    await createSession(testDb.db, {
      tokenHash: 'gone-session',
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const project = await seedProject(testDb.db, user.id);

    await testDb.db.delete(users).where(eq(users.id, user.id));

    expect(await getValidSession(testDb.db, 'gone-session')).toBeUndefined();
    expect(await testDb.db.select().from(projects).where(eq(projects.id, project.id))).toEqual([]);
  });
});
