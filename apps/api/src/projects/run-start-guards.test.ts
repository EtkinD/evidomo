import { Writable } from 'node:stream';
import { apiErrorSchema } from '@evidomo/shared';
import { request as httpRequest } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createAccessCodeMatcher,
  createRunStartGuards,
  runStartLimitsFromEnv,
  type RunStartLimits,
} from './run-start-guards.ts';

// The P4-10 guards in front of a stand-in run start handler: the access code (correct, wrong,
// missing, not configured), the wrong-code limit per IP, and the run start limits per account
// and per IP, which only count starts that answered 201. The wiring in front of the real route
// is covered by projects.integration.test.ts.

const CODE = 'synthetic-test-access-code';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const LIMITS: RunStartLimits = {
  perAccount: { limit: 2, windowMs: DAY },
  perIp: { limit: 3, windowMs: DAY },
  accessCodeFailuresPerIp: { limit: 3, windowMs: HOUR },
};

interface Harness {
  app: Express;
  logs: () => string;
  advance: (ms: number) => void;
  /** Answers of the stand-in handler, in order. */
  handled: () => number;
}

function harness(
  options: {
    accessCode?: string;
    limits?: RunStartLimits;
    status?: (req: Request, res: Response) => number | Promise<number>;
  } = {},
): Harness {
  let logged = '';
  const logger = pino(
    { level: 'info' },
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        logged += chunk.toString('utf8');
        done();
      },
    }),
  );
  let time = 1_000_000;
  let handled = 0;
  const app = express();
  // The client IP comes from X-Forwarded-For here, as behind Caddy in production.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post(
    '/runs',
    ...createRunStartGuards({
      accessCode: options.accessCode,
      limits: options.limits ?? LIMITS,
      logger,
      now: () => time,
      userIdOf: (req) => req.get('x-test-user') ?? 'user-1',
    }),
    async (req, res) => {
      handled += 1;
      const status = (await options.status?.(req, res)) ?? 201;
      res.status(status).json({ ok: status === 201 });
    },
  );
  return {
    app,
    logs: () => logged,
    advance: (ms) => {
      time += ms;
    },
    handled: () => handled,
  };
}

function start(
  app: Express,
  body: unknown,
  { user = 'user-1', ip = '203.0.113.1' }: { user?: string; ip?: string } = {},
): request.Test {
  const test = request(app).post('/runs').set('x-test-user', user).set('X-Forwarded-For', ip);
  return body === undefined ? test : test.send(body as object);
}

function errorOf(response: request.Response): string {
  return apiErrorSchema.parse(response.body).error;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('createAccessCodeMatcher', () => {
  it('matches the exact code only', () => {
    const matches = createAccessCodeMatcher(CODE);
    expect(matches(CODE)).toBe(true);
    for (const candidate of ['', CODE.slice(0, -1), `${CODE}x`, CODE.toUpperCase()]) {
      expect(matches(candidate), candidate).toBe(false);
    }
  });
});

describe('access code', () => {
  it('is not needed when no code is configured, and a sent code is ignored', async () => {
    const { app } = harness();
    expect((await start(app, undefined)).status).toBe(201);
    expect((await start(app, { accessCode: 'anything' }, { user: 'user-2' })).status).toBe(201);
  });

  it('lets the correct code through, trimmed', async () => {
    const { app } = harness({ accessCode: CODE });
    expect((await start(app, { accessCode: CODE })).status).toBe(201);
    expect((await start(app, { accessCode: `  ${CODE}\n` })).status).toBe(201);
  });

  it('answers a wrong or missing code with 403 access_code_invalid', async () => {
    const h = harness({ accessCode: CODE });
    for (const body of [{ accessCode: 'wrong-code-guess' }, {}, undefined]) {
      const response = await start(h.app, body);
      expect(response.status).toBe(403);
      expect(errorOf(response)).toBe('access_code_invalid');
    }
    expect(h.handled()).toBe(0);
  });

  it('refuses a malformed body with 400 before comparing anything', async () => {
    const { app } = harness({ accessCode: CODE });
    const response = await start(app, { accessCode: 42 });
    expect(response.status).toBe(400);
    expect(errorOf(response)).toBe('validation_failed');
    expect(JSON.stringify(response.body)).not.toContain('42');
  });

  it('limits wrong codes per IP, then refuses even the right one until the window ends', async () => {
    const h = harness({ accessCode: CODE });
    // Correct codes and missing codes do not count as wrong attempts.
    expect((await start(h.app, { accessCode: CODE })).status).toBe(201);
    expect((await start(h.app, {}, { user: 'user-2' })).status).toBe(403);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (await start(h.app, { accessCode: `guess-${attempt}` }, { user: 'user-2' })).status,
      ).toBe(403);
    }
    const blocked = await start(h.app, { accessCode: CODE }, { user: 'user-2' });
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked)).toBe('rate_limited');
    expect(blocked.get('retry-after')).toBe(String(HOUR / 1000));
    // Another IP is not affected.
    expect(
      (await start(h.app, { accessCode: CODE }, { user: 'user-3', ip: '203.0.113.2' })).status,
    ).toBe(201);
    h.advance(HOUR);
    expect((await start(h.app, { accessCode: CODE }, { user: 'user-2' })).status).toBe(201);
  });

  it('never logs the submitted or the configured code', async () => {
    const h = harness({ accessCode: CODE });
    await start(h.app, { accessCode: 'a-wrong-guess-value' });
    await start(h.app, { accessCode: CODE });
    await start(h.app, {});
    expect(h.logs()).toContain('wrong access code');
    expect(h.logs()).not.toContain('a-wrong-guess-value');
    expect(h.logs()).not.toContain(CODE);
    expect(h.logs()).not.toContain('203.0.113.1');
  });
});

describe('run start limits', () => {
  it('limits run starts per account and says when to retry', async () => {
    const h = harness();
    expect((await start(h.app, {})).status).toBe(201);
    expect((await start(h.app, {}, { ip: '203.0.113.9' })).status).toBe(201);
    h.advance(HOUR);
    const limited = await start(h.app, {}, { ip: '203.0.113.10' });
    expect(limited.status).toBe(429);
    expect(errorOf(limited)).toBe('run_limit_reached');
    expect(limited.get('retry-after')).toBe(String((DAY - HOUR) / 1000));
    // The refused request did not use the new IP's allowance.
    expect((await start(h.app, {}, { user: 'user-2', ip: '203.0.113.10' })).status).toBe(201);
    h.advance(DAY);
    expect((await start(h.app, {})).status).toBe(201);
  });

  it('limits run starts per IP across accounts', async () => {
    const h = harness();
    for (const user of ['a', 'b', 'c']) expect((await start(h.app, {}, { user })).status).toBe(201);
    const limited = await start(h.app, {}, { user: 'd' });
    expect(limited.status).toBe(429);
    expect(errorOf(limited)).toBe('run_limit_reached');
    expect(h.logs()).toContain('run_start_ip');
    // The refused request did not use account d's allowance.
    expect((await start(h.app, {}, { user: 'd', ip: '198.51.100.7' })).status).toBe(201);
    expect((await start(h.app, {}, { user: 'd', ip: '198.51.100.8' })).status).toBe(201);
    expect((await start(h.app, {}, { user: 'd', ip: '198.51.100.9' })).status).toBe(429);
  });

  it('counts only starts that started a run', async () => {
    const statuses = [409, 409, 409, 500, 201, 201, 409];
    const h = harness({ status: () => statuses.shift() ?? 201 });
    for (const expected of [409, 409, 409, 500, 201, 201]) {
      expect((await start(h.app, {})).status).toBe(expected);
    }
    // Two 201s used the account's allowance of 2; the refusals before them did not count.
    expect((await start(h.app, {})).status).toBe(429);
  });

  it('gives the full allowance back after refusals while a start was still in flight', async () => {
    // Start A is in flight (it will answer 409), B starts a run, C is refused at the limit of 2.
    // A's refund must free a real slot: the user has started one run and may start another.
    let releaseA: (() => void) | undefined;
    const aDone = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let calls = 0;
    const h = harness({
      status: async (req) => {
        calls += 1;
        if (req.get('x-start') !== 'a') return 201;
        await aDone;
        return 409;
      },
    });
    const a = start(h.app, {})
      .set('x-start', 'a')
      .then((response) => response.status);
    await until(() => calls === 1);
    expect((await start(h.app, {})).status).toBe(201);
    for (let i = 0; i < 3; i += 1) expect((await start(h.app, {})).status).toBe(429);
    releaseA?.();
    expect(await a).toBe(409);
    expect((await start(h.app, {})).status).toBe(201);
    expect((await start(h.app, {})).status).toBe(429);
  });

  it('keeps the reservation when the client disconnects before the answer', async () => {
    let first = true;
    const server = harness({
      status: (_req, res) => {
        if (!first) return 201;
        first = false;
        // Answers only after the client is gone, with a status that would otherwise refund.
        return new Promise<number>((resolve) => {
          res.once('close', () => resolve(409));
        });
      },
    });
    const listening = server.app.listen(0);
    await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
    const address = listening.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
    try {
      const body = '{}';
      const aborted = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/runs',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
          'x-forwarded-for': '203.0.113.1',
        },
      });
      aborted.on('error', () => undefined);
      aborted.end(body);
      await until(() => server.handled() === 1);
      aborted.destroy();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The aborted start kept its slot (the run may have started): one more, then the limit.
      expect((await start(server.app, {})).status).toBe(201);
      expect((await start(server.app, {})).status).toBe(429);
    } finally {
      await new Promise<void>((resolve) => listening.close(() => resolve()));
    }
  });

  it('applies after the access code: a wrong code does not use the run allowance', async () => {
    const h = harness({ accessCode: CODE });
    await start(h.app, { accessCode: 'wrong-guess-1' });
    await start(h.app, { accessCode: 'wrong-guess-2' });
    expect((await start(h.app, { accessCode: CODE })).status).toBe(201);
    expect((await start(h.app, { accessCode: CODE })).status).toBe(201);
    expect((await start(h.app, { accessCode: CODE })).status).toBe(429);
  });

  it('reads the defaults and windows from the environment', () => {
    expect(
      runStartLimitsFromEnv({
        RUN_STARTS_PER_ACCOUNT_PER_DAY: 3,
        RUN_STARTS_PER_IP_PER_DAY: 5,
        ACCESS_CODE_FAILURES_PER_IP_PER_HOUR: 10,
      }),
    ).toEqual({
      perAccount: { limit: 3, windowMs: DAY },
      perIp: { limit: 5, windowMs: DAY },
      accessCodeFailuresPerIp: { limit: 10, windowMs: HOUR },
    });
  });
});
