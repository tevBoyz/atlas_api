import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { type AuthenticatedUser, CurrentUser } from '../../src/common/auth';
import { Operation } from '../../src/common/errors';
import { Public, SkipRateLimit } from '../../src/common/guards/route-access';
import { Idempotent } from '../../src/common/idempotency';
import { RATE_LIMIT_KEY_PREFIX, RateLimit, RateLimiterService } from '../../src/common/rate-limit';
import { DatabaseService } from '../../src/db';
import { RedisService } from '../../src/redis';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { authHeader, signTestToken } from '../../src/testing/test-tokens';
import { StallingRedisProxy } from '../support/stalling-redis-proxy';

/**
 * Rate limiting against a real Redis container (API-100-11). The routes below are test-only.
 * Each test starts with an empty Redis index (this worker's own).
 */
const LIMIT = 10;
let handlerRuns = 0;

@Controller('test-rl')
class RateLimitIntController {
  @Get('limited')
  @Operation('ping')
  @RateLimit({ name: 'test_limited', max: LIMIT, windowSeconds: 60, scope: 'user' })
  limited(@CurrentUser() user: AuthenticatedUser) {
    return { user_id: user.id };
  }

  @Get('window')
  @Operation('ping')
  @RateLimit({ name: 'test_window', max: 3, windowSeconds: 1, scope: 'user' })
  window() {
    return { ok: true };
  }

  @Get('default')
  @Operation('ping')
  defaultPolicy() {
    return { ok: true };
  }

  @Get('emergency')
  @Operation('ping')
  @RateLimit('emergency_write')
  emergency() {
    return { ok: true };
  }

  @Post('incidents/:id/location')
  @Operation('ping')
  @RateLimit({ name: 'test_ping', max: 2, windowSeconds: 60, scope: 'user_incident' })
  location(@Param('id') id: string) {
    return { id };
  }

  @Post('idempotent')
  @Operation('ping')
  @Idempotent('required')
  @RateLimit({ name: 'test_idempotent', max: 1, windowSeconds: 60, scope: 'user' })
  idempotent(@Body() body: { label: string }) {
    handlerRuns += 1;
    return { label: body.label, run: handlerRuns };
  }

  @Get('public')
  @Public()
  @RateLimit({ name: 'test_public', max: 2, windowSeconds: 60, scope: 'ip' })
  publicRoute() {
    return { ok: true };
  }

  @Get('skipped')
  @Operation('ping')
  @SkipRateLimit()
  skipped() {
    return { ok: true };
  }
}

const controllers = [RateLimitIntController];
const OVER_LIMIT = { error: { code: 'rate_limit:exceeded', details: {} } };

describe('Rate limiting against Redis (API-100-11)', () => {
  let app: NestFastifyApplication;
  let redis: RedisService;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      { controllers },
      withTestConfig({ RATE_LIMIT_AUTH_FAILURE_MAX: '5' }),
    ));
    redis = app.get(RedisService);
    await waitForRedis(redis);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await redis.client.flushdb();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });
  const newUser = () => authHeader(randomUUID());

  describe('counter', () => {
    it('AC1: over the limit → 429, Retry-After and rate_limit:exceeded', async () => {
      const auth = await newUser();
      for (let i = 0; i < LIMIT; i++) {
        expect((await get('/v1/test-rl/limited', auth)).statusCode).toBe(200);
      }
      const refused = await get('/v1/test-rl/limited', auth);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject(OVER_LIMIT);
      const retryAfter = Number(refused.headers['retry-after']);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });

    it('RACE: N parallel requests at limit L admit exactly L', async () => {
      const auth = await newUser();
      const results = await Promise.all(
        Array.from({ length: 60 }, () => get('/v1/test-rl/limited', auth)),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(LIMIT);
      expect(results.filter((r) => r.statusCode === 429)).toHaveLength(60 - LIMIT);
    });

    it('RACE: two API instances sharing Redis admit exactly L between them', async () => {
      const other = await createTestApp({ controllers });
      await waitForRedis(other.app.get(RedisService));
      try {
        const auth = await newUser();
        const results = await Promise.all(
          Array.from({ length: 40 }, (_, i) =>
            (i % 2 === 0 ? app : other.app).inject({
              method: 'GET',
              url: '/v1/test-rl/limited',
              headers: auth,
            }),
          ),
        );
        expect(results.filter((r) => r.statusCode === 200)).toHaveLength(LIMIT);
      } finally {
        await other.app.close();
      }
    });

    it('RACE: time comes from Redis, so a skewed API clock changes nothing', async () => {
      const limiter = app.get(RateLimiterService);
      const key = `${RATE_LIMIT_KEY_PREFIX}:test_skew:${randomUUID()}`;
      expect((await limiter.consume(key, 2, 60)).allowed).toBe(true);
      expect((await limiter.consume(key, 2, 60)).allowed).toBe(true);
      const realNow = Date.now();
      const skewed = jest.spyOn(Date, 'now').mockReturnValue(realNow + 3_600_000);
      try {
        expect((await limiter.consume(key, 2, 60)).allowed).toBe(false);
      } finally {
        skewed.mockRestore();
      }
    });

    it('RACE: every key is written with a TTL in the same atomic step', async () => {
      const auth = await newUser();
      await Promise.all(Array.from({ length: 25 }, () => get('/v1/test-rl/limited', auth)));
      const keys = await redis.client.keys(`${RATE_LIMIT_KEY_PREFIX}:*`);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        const ttl = await redis.client.pttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60_000);
      }
    });

    it('a refused request is not recorded (it does not extend the wait)', async () => {
      const limiter = app.get(RateLimiterService);
      const key = `${RATE_LIMIT_KEY_PREFIX}:test_refused:${randomUUID()}`;
      await limiter.consume(key, 1, 60);
      await limiter.consume(key, 1, 60);
      await limiter.consume(key, 1, 60);
      expect(await redis.client.zcard(key)).toBe(1);
    });

    it('sliding window: no window of the policy length ever holds more than L', async () => {
      const auth = await newUser();
      const admitted: number[] = [];
      const started = Date.now();
      while (Date.now() - started < 2_300) {
        const at = Date.now();
        const res = await get('/v1/test-rl/window', auth);
        if (res.statusCode === 200) admitted.push(at);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Limit 3 per second: the 4th admission after any admission is at least ~1 s later.
      expect(admitted.length).toBeGreaterThanOrEqual(6);
      for (let i = 0; i + 3 < admitted.length; i++) {
        expect(admitted[i + 3] - admitted[i]).toBeGreaterThanOrEqual(900);
      }
    });

    it('a slot frees up once the window has passed', async () => {
      const auth = await newUser();
      for (let i = 0; i < 3; i++) await get('/v1/test-rl/window', auth);
      expect((await get('/v1/test-rl/window', auth)).statusCode).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect((await get('/v1/test-rl/window', auth)).statusCode).toBe(200);
    });
  });

  describe('keys and policies', () => {
    it('per user: one user over the limit does not affect another', async () => {
      const a = await newUser();
      const b = await newUser();
      for (let i = 0; i < LIMIT + 1; i++) await get('/v1/test-rl/limited', a);
      expect((await get('/v1/test-rl/limited', a)).statusCode).toBe(429);
      expect((await get('/v1/test-rl/limited', b)).statusCode).toBe(200);
    });

    it('AC2: authenticated routes default to 300 per minute per user', async () => {
      const userId = randomUUID();
      await get('/v1/test-rl/default', await authHeader(userId));
      const key = `${RATE_LIMIT_KEY_PREFIX}:authenticated:u:${userId}`;
      expect(await redis.client.zcard(key)).toBe(1);
      expect(await redis.client.pttl(key)).toBeLessThanOrEqual(60_000);
    });

    it('AC2: SOS routes count only against their own policy, never the general one', async () => {
      const userId = randomUUID();
      await get('/v1/test-rl/emergency', await authHeader(userId));
      expect(await redis.client.zcard(`${RATE_LIMIT_KEY_PREFIX}:emergency_write:u:${userId}`)).toBe(
        1,
      );
      expect(await redis.client.exists(`${RATE_LIMIT_KEY_PREFIX}:authenticated:u:${userId}`)).toBe(
        0,
      );
    });

    it('AC2: per user per incident: incidents have separate counters', async () => {
      const auth = await newUser();
      const first = randomUUID();
      const post = (id: string) =>
        app.inject({ method: 'POST', url: `/v1/test-rl/incidents/${id}/location`, headers: auth });
      expect((await post(first)).statusCode).toBe(201);
      expect((await post(first)).statusCode).toBe(201);
      expect((await post(first)).statusCode).toBe(429);
      expect((await post(randomUUID())).statusCode).toBe(201);
    });

    it('per user per incident: inventing incident ids still hits the user limit', async () => {
      const userId = randomUUID();
      const auth = await authHeader(userId);
      await redis.client.zadd(
        `${RATE_LIMIT_KEY_PREFIX}:authenticated:u:${userId}`,
        ...Array.from({ length: 300 }, (_, i) => [Date.now() * 1000, `seed-${i}`]).flat(),
      );
      const res = await app.inject({
        method: 'POST',
        url: `/v1/test-rl/incidents/${randomUUID()}/location`,
        headers: auth,
      });
      expect(res.statusCode).toBe(429);
    });

    it('per IP on a public route', async () => {
      expect((await get('/v1/test-rl/public')).statusCode).toBe(200);
      expect((await get('/v1/test-rl/public')).statusCode).toBe(200);
      const refused = await get('/v1/test-rl/public');
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBeDefined();
    });
  });

  describe('AC4: routes that are never limited', () => {
    it('health and readiness: no counter, no 429', async () => {
      for (let i = 0; i < 80; i++) {
        expect((await get('/healthz')).statusCode).toBe(200);
      }
      expect((await get('/readyz')).statusCode).toBe(200);
      expect(await redis.client.keys(`${RATE_LIMIT_KEY_PREFIX}:*`)).toEqual([]);
    });

    it('@SkipRateLimit on an authenticated route', async () => {
      const auth = await newUser();
      for (let i = 0; i < LIMIT + 5; i++) {
        expect((await get('/v1/test-rl/skipped', auth)).statusCode).toBe(200);
      }
      expect(await redis.client.keys(`${RATE_LIMIT_KEY_PREFIX}:*`)).toEqual([]);
    });
  });

  describe('guard order', () => {
    const badToken = { authorization: 'Bearer not-a-jwt' };

    it('requests rejected by auth are limited per IP (5 → 401, then 429)', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await get('/v1/test-rl/default', badToken);
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: { code: 'ping:not_authenticated' } });
      }
      const refused = await get('/v1/test-rl/default', badToken);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject(OVER_LIMIT);
      expect(refused.headers['retry-after']).toBeDefined();
    });

    it('expired tokens and missing tokens count the same way', async () => {
      const expired = await signTestToken({ expiresInSeconds: -120 });
      for (let i = 0; i < 3; i++) {
        await get('/v1/test-rl/default', { authorization: `Bearer ${expired}` });
        await get('/v1/test-rl/default');
      }
      expect((await get('/v1/test-rl/default')).statusCode).toBe(429);
    });

    it('a valid token is never refused because its IP is over the auth-failure limit', async () => {
      for (let i = 0; i < 6; i++) await get('/v1/test-rl/default', badToken);
      expect((await get('/v1/test-rl/default', badToken)).statusCode).toBe(429);
      expect((await get('/v1/test-rl/default', await newUser())).statusCode).toBe(200);
    });

    it('a rejected request does not consume any user budget', async () => {
      await get('/v1/test-rl/limited', badToken);
      const keys = await redis.client.keys(`${RATE_LIMIT_KEY_PREFIX}:test_limited:*`);
      expect(keys).toEqual([]);
    });

    it('RACE: a 429 is never stored as an idempotent response', async () => {
      const userId = randomUUID();
      const auth = await authHeader(userId);
      const database = app.get(DatabaseService);
      const firstKey = randomUUID();
      const refusedKey = randomUUID();
      const post = (key: string) =>
        app.inject({
          method: 'POST',
          url: '/v1/test-rl/idempotent',
          headers: { ...auth, 'idempotency-key': key },
          payload: { label: 'same' },
        });

      expect((await post(firstKey)).statusCode).toBe(201);
      const runsAfterFirst = handlerRuns;
      const refused = await post(refusedKey);
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['idempotent-replayed']).toBeUndefined();
      expect(handlerRuns).toBe(runsAfterFirst);

      const rows = await database.query(
        'select key from public.idempotency_keys where user_id = $1 and key = $2',
        [userId, refusedKey],
      );
      expect(rows).toEqual([]);

      // Once the limit clears, the same key runs for real: the 429 was not remembered.
      await redis.client.flushdb();
      const retried = await post(refusedKey);
      expect(retried.statusCode).toBe(201);
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
      expect(handlerRuns).toBe(runsAfterFirst + 1);
    });
  });
});

describe('AC3: client IP (API-100-11)', () => {
  async function appWithProxy(trustProxy: string): Promise<NestFastifyApplication> {
    const { app } = await createTestApp(
      { controllers },
      withTestConfig({ TRUST_PROXY: trustProxy }),
    );
    await waitForRedis(app.get(RedisService));
    await app.get(RedisService).client.flushdb();
    return app;
  }
  const from = (app: NestFastifyApplication, forwardedFor: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/test-rl/public',
      headers: { 'x-forwarded-for': forwardedFor },
    });

  it('TRUST_PROXY on: the first x-forwarded-for value is the client', async () => {
    const app = await appWithProxy('true');
    try {
      await from(app, '198.51.100.1, 10.0.0.1');
      await from(app, '198.51.100.1, 10.0.0.2');
      expect((await from(app, '198.51.100.1')).statusCode).toBe(429);
      expect((await from(app, '198.51.100.2, 10.0.0.1')).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('TRUST_PROXY off: x-forwarded-for is ignored, the socket address counts', async () => {
    const app = await appWithProxy('false');
    try {
      await from(app, '198.51.100.1');
      await from(app, '198.51.100.2');
      expect((await from(app, '198.51.100.3')).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('TRUST_PROXY on: a value that is not an IP falls back to the socket address', async () => {
    const app = await appWithProxy('true');
    try {
      await from(app, 'not-an-ip');
      await from(app, 'also-not-an-ip');
      expect((await from(app, 'still-not-an-ip')).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe('Fail open (API-100-11): an SOS is never refused because of the limiter', () => {
  const warnings = (logs: LogCapture) =>
    logs.lines.filter(
      (line) => line.msg === 'rate limiter unavailable, requests are not being limited',
    );

  it('Redis down: requests pass, and one warning is logged for the whole outage', async () => {
    const { app, logs } = await createTestApp(
      { controllers },
      withTestConfig({ REDIS_URL: 'redis://127.0.0.1:1' }),
    );
    try {
      const auth = await authHeader(randomUUID());
      const results = await Promise.all(
        Array.from({ length: LIMIT * 3 }, () =>
          app.inject({ method: 'GET', url: '/v1/test-rl/limited', headers: auth }),
        ),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(warnings(logs)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('Redis slow: requests pass within the timeout; limiting resumes after recovery', async () => {
    const proxy = new StallingRedisProxy();
    const url = await proxy.start(process.env.REDIS_URL!);
    const { app, logs } = await createTestApp(
      { controllers },
      withTestConfig({ REDIS_URL: url, RATE_LIMIT_REDIS_TIMEOUT_MS: '100' }),
    );
    try {
      await waitForRedis(app.get(RedisService));
      await app.get(RedisService).client.flushdb();
      const auth = await authHeader(randomUUID());

      proxy.stalled = true;
      const started = Date.now();
      const results = await Promise.all(
        Array.from({ length: LIMIT * 2 }, () =>
          app.inject({ method: 'GET', url: '/v1/test-rl/limited', headers: auth }),
        ),
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(warnings(logs)).toHaveLength(1);

      proxy.resume();
      await app.get(RedisService).client.flushdb();
      const after = await Promise.all(
        Array.from({ length: LIMIT + 5 }, () =>
          app.inject({ method: 'GET', url: '/v1/test-rl/limited', headers: auth }),
        ),
      );
      expect(after.filter((r) => r.statusCode === 429)).toHaveLength(5);
      expect(logs.lines.filter((line) => line.msg === 'rate limiter restored')).toHaveLength(1);
    } finally {
      await app.close();
      await proxy.stop();
    }
  });
});

/** Redis connects in the background after startup. */
async function waitForRedis(redis: RedisService): Promise<void> {
  for (let i = 0; i < 100 && redis.client.status !== 'ready'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(redis.client.status).toBe('ready');
}
