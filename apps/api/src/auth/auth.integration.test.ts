import { eq, sql } from 'drizzle-orm';
import express, { type Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema, authUserResponseSchema } from '@evidomo/shared';
import { appConfigFromEnv, createApp } from '../app.ts';
import { sessions, users } from '../db/schema.ts';
import { startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadEnv } from '../env.ts';
import { createErrorHandler } from '../http/errors.ts';
import { authConfigFromEnv, DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './config.ts';
import { createSessionMiddleware, currentUser, optionalUser } from './session.ts';
import { hashSessionToken } from './tokens.ts';

const logger = pino({ enabled: false });
const DATABASE_URL = 'postgres://u:p@localhost:5432/db';
const PASSWORD = 'correct horse battery staple';

const devEnv = loadEnv({ DATABASE_URL, NODE_ENV: 'test' });
const prodEnv = loadEnv({
  DATABASE_URL,
  NODE_ENV: 'production',
  MODEL_API_KEY: 'test-key',
  DAILY_BUDGET_USD: '1',
  STORAGE_DIR: '/data',
  APP_ORIGIN: 'https://evidomo.example',
});

let emailCounter = 0;
function uniqueEmail(): string {
  emailCounter += 1;
  return `agent-${emailCounter}@example.test`;
}

/** The session token from a Set-Cookie header, plus the header itself. */
function sessionCookie(
  response: request.Response,
  name = 'evidomo_session',
): { token: string; header: string } {
  const headers = response.headers['set-cookie'];
  const list: string[] = Array.isArray(headers) ? headers : [];
  const header = list.find((value) => value.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`no ${name} cookie in response`);
  const token = header.slice(name.length + 1, header.indexOf(';'));
  return { token, header };
}

describe('auth API against a real PostgreSQL', () => {
  let testDb: TestDatabase;
  let app: Express;

  function appWith(env = devEnv, rateLimits: AuthRateLimits = DEFAULT_AUTH_RATE_LIMITS): Express {
    return createApp({ db: testDb.client, logger, config: appConfigFromEnv(env, rateLimits) });
  }

  async function register(target: Express, email = uniqueEmail()): Promise<request.Response> {
    return request(target).post('/api/auth/register').send({ email, password: PASSWORD });
  }

  async function sessionRow(token: string) {
    const [row] = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    return row;
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    app = appWith();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it('registers, reads the current user, logs out, and is then unauthenticated', async () => {
    const agent = request.agent(app);
    const email = uniqueEmail();

    const registered = await agent
      .post('/api/auth/register')
      .send({ email: `  ${email.toUpperCase()} `, password: PASSWORD });
    expect(registered.status).toBe(201);
    const { user } = authUserResponseSchema.parse(registered.body);
    expect(user.email).toBe(email);
    expect(registered.body).toEqual({ user: { id: user.id, email } });

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user: { id: user.id, email } });
    expect(me.headers['cache-control']).toBe('no-store');

    const loggedOut = await agent.post('/api/auth/logout');
    expect(loggedOut.status).toBe(204);
    expect(loggedOut.headers['set-cookie']?.[0]).toMatch(/^evidomo_session=;/);

    const after = await agent.get('/api/auth/me');
    expect(after.status).toBe(401);
    expect(apiErrorSchema.parse(after.body)).toEqual({ error: 'unauthenticated' });
  });

  it('deletes the session row on logout, so a replayed cookie is dead', async () => {
    const registered = await register(app);
    const { token } = sessionCookie(registered);
    expect(await sessionRow(token)).toBeDefined();

    await request(app).post('/api/auth/logout').set('Cookie', `evidomo_session=${token}`);

    expect(await sessionRow(token)).toBeUndefined();
    const replay = await request(app).get('/api/auth/me').set('Cookie', `evidomo_session=${token}`);
    expect(replay.status).toBe(401);
  });

  it('answers logout without a session with 204', async () => {
    const response = await request(app).post('/api/auth/logout');

    expect(response.status).toBe(204);
  });

  it('rejects a duplicate registration with 409, regardless of case', async () => {
    const email = uniqueEmail();
    expect((await register(app, email)).status).toBe(201);

    const duplicate = await register(app, email.toUpperCase());

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ error: 'email_taken' });
    expect(duplicate.headers['set-cookie']).toBeUndefined();
    const rows = await testDb.db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, email));
    expect(rows).toHaveLength(1);
  });

  it('stores an argon2id hash, never the password', async () => {
    const email = uniqueEmail();
    await register(app, email);

    const [row] = await testDb.db.select().from(users).where(eq(users.email, email));

    expect(row?.passwordHash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(row?.passwordHash).not.toContain(PASSWORD);
  });

  it('stores only the SHA-256 of the session token, never the raw token', async () => {
    const registered = await register(app);
    const { token } = sessionCookie(registered);

    const allSessions = await testDb.db.select().from(sessions);
    expect(JSON.stringify(allSessions)).not.toContain(token);
    expect(await sessionRow(token)).toBeDefined();
    const [raw] = await testDb.db.select().from(sessions).where(eq(sessions.tokenHash, token));
    expect(raw).toBeUndefined();
  });

  it('logs in with the right password and rotates the session', async () => {
    const email = uniqueEmail();
    const registered = await register(app, email);
    const { token: oldToken } = sessionCookie(registered);

    const login = await request(app)
      .post('/api/auth/login')
      .set('Cookie', `evidomo_session=${oldToken}`)
      .send({ email: email.toUpperCase(), password: PASSWORD });

    expect(login.status).toBe(200);
    expect(authUserResponseSchema.parse(login.body).user.email).toBe(email);
    const { token: newToken } = sessionCookie(login);
    expect(newToken).not.toBe(oldToken);
    expect(await sessionRow(oldToken)).toBeUndefined();
    expect(await sessionRow(newToken)).toBeDefined();
  });

  it('gives a wrong password and an unknown email the same response', async () => {
    const email = uniqueEmail();
    await register(app, email);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'not the right password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail(), password: PASSWORD });

    for (const response of [wrongPassword, unknownEmail]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'invalid_credentials' });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(Object.keys(wrongPassword.headers).sort()).toEqual(
      Object.keys(unknownEmail.headers).sort(),
    );
  });

  it('rejects an expired session, deletes its row, and clears the cookie', async () => {
    const registered = await register(app);
    const { token } = sessionCookie(registered);
    await testDb.db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.tokenHash, hashSessionToken(token)));

    const me = await request(app).get('/api/auth/me').set('Cookie', `evidomo_session=${token}`);

    expect(me.status).toBe(401);
    expect(me.headers['set-cookie']?.[0]).toMatch(/^evidomo_session=;/);
    expect(await sessionRow(token)).toBeUndefined();
  });

  it('sweeps other expired sessions on login', async () => {
    const stale = sessionCookie(await register(app));
    await testDb.db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 day'` })
      .where(eq(sessions.tokenHash, hashSessionToken(stale.token)));
    const email = uniqueEmail();
    await register(app, email);

    await request(app).post('/api/auth/login').send({ email, password: PASSWORD });

    expect(await sessionRow(stale.token)).toBeUndefined();
  });

  describe('session cookie attributes', () => {
    it('in development: HttpOnly, SameSite=Lax, Path=/, absolute Max-Age, not Secure', async () => {
      const { header } = sessionCookie(await register(app));

      expect(header).toMatch(/; HttpOnly/);
      expect(header).toMatch(/; SameSite=Lax/);
      expect(header).toMatch(/; Path=\//);
      expect(header).toMatch(/; Max-Age=2592000/);
      expect(header).not.toMatch(/; Secure/);
      expect(header).not.toMatch(/; Domain=/i);
    });

    it('in production: the __Host- prefix and Secure, with the same other attributes', async () => {
      const prodApp = appWith(prodEnv);
      const registered = await register(prodApp);
      const { header, token } = sessionCookie(registered, '__Host-evidomo_session');

      expect(header).toMatch(/; Secure/);
      expect(header).toMatch(/; HttpOnly/);
      expect(header).toMatch(/; SameSite=Lax/);
      expect(header).toMatch(/; Path=\//);
      expect(header).not.toMatch(/; Domain=/i);

      const me = await request(prodApp)
        .get('/api/auth/me')
        .set('Cookie', `__Host-evidomo_session=${token}`);
      expect(me.status).toBe(200);
      // The development cookie name means nothing to the production configuration.
      const wrongName = await request(prodApp)
        .get('/api/auth/me')
        .set('Cookie', `evidomo_session=${token}`);
      expect(wrongName.status).toBe(401);
    });

    it('honours SESSION_TTL_DAYS for the cookie and the stored expiry', async () => {
      const shortApp = appWith({ ...devEnv, SESSION_TTL_DAYS: 1 });
      const before = Date.now();
      const { header, token } = sessionCookie(await register(shortApp));

      expect(header).toMatch(/; Max-Age=86400/);
      const row = await sessionRow(token);
      const expiresIn = (row?.expiresAt.getTime() ?? 0) - before;
      expect(expiresIn).toBeGreaterThan(86_400_000 - 5_000);
      expect(expiresIn).toBeLessThanOrEqual(86_400_000 + 5_000);
    });
  });

  describe('rate limiting', () => {
    const tight: AuthRateLimits = {
      loginPerIp: { limit: 3, windowMs: 60_000 },
      loginPerAccount: { limit: 2, windowMs: 60_000 },
      registerPerIp: { limit: 1, windowMs: 60_000 },
    };

    it('limits login attempts per IP with 429 and Retry-After', async () => {
      const limited = appWith(devEnv, tight);
      const attempt = (email: string) =>
        request(limited).post('/api/auth/login').send({ email, password: 'wrong password' });

      for (let i = 0; i < 3; i++) expect((await attempt(uniqueEmail())).status).toBe(401);
      const blocked = await attempt(uniqueEmail());

      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ error: 'rate_limited' });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('limits login attempts per account across IPs, for unknown emails too', async () => {
      const limited = appWith({ ...devEnv, TRUST_PROXY_HOPS: 1 }, tight);
      const attempt = (email: string, ip: string) =>
        request(limited)
          .post('/api/auth/login')
          .set('X-Forwarded-For', ip)
          .send({ email, password: 'wrong password' });

      for (const email of [uniqueEmail(), 'nobody@example.test']) {
        expect((await attempt(email, '198.51.100.1')).status).toBe(401);
        expect((await attempt(email, '198.51.100.2')).status).toBe(401);
        const blocked = await attempt(email, '198.51.100.3');
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      }
    });

    it('resets the account counter after a successful login', async () => {
      const limited = appWith({ ...devEnv, TRUST_PROXY_HOPS: 1 }, tight);
      const email = uniqueEmail();
      await register(app, email);
      const login = (password: string, ip: string) =>
        request(limited)
          .post('/api/auth/login')
          .set('X-Forwarded-For', ip)
          .send({ email, password });

      expect((await login('wrong password', '198.51.100.10')).status).toBe(401);
      expect((await login(PASSWORD, '198.51.100.11')).status).toBe(200);
      expect((await login('wrong password', '198.51.100.12')).status).toBe(401);
      expect((await login(PASSWORD, '198.51.100.13')).status).toBe(200);
    });

    it('limits registration per IP', async () => {
      const limited = appWith(devEnv, tight);

      expect((await register(limited)).status).toBe(201);
      const blocked = await register(limited);
      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
    });
  });

  describe('CSRF and content-type guards', () => {
    it('rejects a cross-origin POST and creates nothing', async () => {
      const email = uniqueEmail();

      const response = await request(app)
        .post('/api/auth/register')
        .set('Origin', 'https://evil.example')
        .send({ email, password: PASSWORD });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'forbidden_origin' });
      expect(await testDb.db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
    });

    it('rejects a cross-origin logout, leaving the session intact', async () => {
      const { token } = sessionCookie(await register(app));

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Origin', 'https://evil.example')
        .set('Cookie', `evidomo_session=${token}`);

      expect(response.status).toBe(403);
      expect(await sessionRow(token)).toBeDefined();
    });

    it('accepts the configured origin', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .set('Origin', devEnv.APP_ORIGIN)
        .send({ email: uniqueEmail(), password: PASSWORD });

      expect(response.status).toBe(201);
    });

    it('rejects a non-JSON POST with 415 and creates nothing', async () => {
      const email = uniqueEmail();

      const response = await request(app)
        .post('/api/auth/register')
        .type('form')
        .send({ email, password: PASSWORD });

      expect(response.status).toBe(415);
      expect(response.body).toEqual({ error: 'unsupported_media_type' });
      expect(await testDb.db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
    });
  });

  describe('reusable session middleware', () => {
    function protectedApp(): Express {
      const config = authConfigFromEnv(devEnv);
      const session = createSessionMiddleware({ db: testDb.db, config });
      const custom = express();
      custom.get('/private', session.requireUser, (req, res) => {
        res.json(currentUser(req));
      });
      custom.get('/public', session.loadUser, (req, res) => {
        res.json({ user: optionalUser(req) ?? null });
      });
      custom.get('/miswired', (req, res) => {
        res.json(currentUser(req));
      });
      custom.use(createErrorHandler(logger));
      return custom;
    }

    it('protects a route and exposes the typed user', async () => {
      const registered = await register(app);
      const { token } = sessionCookie(registered);
      const { user } = authUserResponseSchema.parse(registered.body);
      const custom = protectedApp();

      const anonymous = await request(custom).get('/private');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toEqual({ error: 'unauthenticated' });

      const signedIn = await request(custom)
        .get('/private')
        .set('Cookie', `evidomo_session=${token}`);
      expect(signedIn.status).toBe(200);
      expect(signedIn.body).toEqual({ id: user.id, email: user.email });

      expect((await request(custom).get('/public')).body).toEqual({ user: null });
      expect(
        (await request(custom).get('/public').set('Cookie', `evidomo_session=${token}`)).body,
      ).toEqual({ user: { id: user.id, email: user.email } });
    });

    it('fails loudly when currentUser is used on an unprotected route', async () => {
      const response = await request(protectedApp()).get('/miswired');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'internal_error' });
    });
  });
});
