import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';

import { isPublicRoute, skipsRateLimit } from '../common/guards/route-access';
import { DataStoreNotConfiguredError, DatabaseService } from '../db';
import { ROOT_LOGGER } from '../observability/logger';
import { RedisService } from '../redis';
import { createTestApp, type LogCapture } from '../testing/test-app';
import { EXPECTED_MIGRATIONS } from './expected-migrations';
import { HealthController } from './health.controller';
import { READINESS_TIMEOUT_MS } from './readiness.service';

/** Fastify runs onResponse hooks after inject() resolves: let them finish before reading logs. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const never = () => new Promise<never>(() => undefined);

const TIMEOUT_MS = 100;

/** The controller method itself (the object Nest attaches route metadata to). */
function handlerOf(name: 'healthz' | 'readyz'): unknown {
  return Object.getOwnPropertyDescriptor(HealthController.prototype, name)?.value;
}

describe('Health and readiness (API-100-07)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  const database = { ping: jest.fn(), query: jest.fn() };
  const redis = { ping: jest.fn() };
  const expected = { ids: [] as string[] };

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({}, (builder) =>
      builder
        .overrideProvider(DatabaseService)
        .useValue(database)
        .overrideProvider(RedisService)
        .useValue(redis)
        .overrideProvider(EXPECTED_MIGRATIONS)
        .useValue(expected)
        .overrideProvider(READINESS_TIMEOUT_MS)
        .useValue(TIMEOUT_MS),
    ));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    database.ping.mockReset().mockResolvedValue(undefined);
    database.query.mockReset().mockResolvedValue([]);
    redis.ping.mockReset().mockResolvedValue(undefined);
    expected.ids = [];
    logs.raw.length = 0;
  });

  describe('GET /healthz (AC1)', () => {
    it('answers 200 {"status":"ok"} without checking any dependency', async () => {
      database.ping.mockImplementation(never);
      redis.ping.mockRejectedValue(new Error('down'));
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('{"status":"ok"}');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(database.ping).not.toHaveBeenCalled();
      expect(redis.ping).not.toHaveBeenCalled();
      expect(database.query).not.toHaveBeenCalled();
    });

    it('is served at the root only', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/healthz' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/v1/readyz' })).statusCode).toBe(404);
    });
  });

  describe('GET /readyz (AC2)', () => {
    it('answers 200 {"status":"ok"} when the DB query, Redis PING and migrations pass', async () => {
      expected.ids = ['0001_a'];
      database.query.mockResolvedValue([{ id: '0001_a' }]);
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('{"status":"ok"}');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(database.ping).toHaveBeenCalledTimes(1);
      expect(redis.ping).toHaveBeenCalledTimes(1);
      expect(database.query).toHaveBeenCalledWith(
        'select id from public.api_schema_migrations where id = any($1::text[])',
        [['0001_a']],
      );
    });

    it('passes the migrations check with zero migrations without querying', async () => {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(database.query).not.toHaveBeenCalled();
    });

    it.each([
      ['db', () => database.ping.mockRejectedValue(new Error('ECONNREFUSED'))],
      ['redis', () => redis.ping.mockRejectedValue(new Error('Stream is not writeable'))],
      [
        'migrations',
        () => {
          expected.ids = ['0001_a', '0002_b'];
          database.query.mockResolvedValue([{ id: '0001_a' }]);
        },
      ],
    ] as const)(
      'answers 503 with failed ["%s"] when only that check fails',
      async (name, arrange) => {
        arrange();
        const res = await app.inject({ method: 'GET', url: '/readyz' });
        expect(res.statusCode).toBe(503);
        expect(res.body).toBe(`{"status":"unavailable","failed":["${name}"]}`);
      },
    );

    it('lists every failing check in the order db, redis, migrations', async () => {
      expected.ids = ['0001_a'];
      database.query.mockRejectedValue(new Error('relation does not exist'));
      redis.ping.mockRejectedValue(new Error('down'));
      database.ping.mockRejectedValue(new Error('down'));
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'unavailable', failed: ['db', 'redis', 'migrations'] });
    });

    it('reports not-configured stores as failed (development/test without URLs)', async () => {
      database.ping.mockRejectedValue(new DataStoreNotConfiguredError('DATABASE_URL'));
      redis.ping.mockRejectedValue(new DataStoreNotConfiguredError('REDIS_URL'));
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.json()).toEqual({ status: 'unavailable', failed: ['db', 'redis'] });
    });

    it('fails the migrations check when the migration list is unavailable', async () => {
      // Simulates loadExpectedMigrations() returning an error (e.g. image built without the list).
      const broken = app.get<Record<string, unknown>>(EXPECTED_MIGRATIONS);
      broken.error = 'no migrations manifest and no db/migrations directory';
      try {
        const res = await app.inject({ method: 'GET', url: '/readyz' });
        expect(res.json()).toEqual({ status: 'unavailable', failed: ['migrations'] });
      } finally {
        delete broken.error;
      }
    });

    it('answers within the per-check timeout when a dependency hangs', async () => {
      redis.ping.mockImplementation(never);
      database.ping.mockImplementation(never);
      const started = Date.now();
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 500);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'unavailable', failed: ['db', 'redis'] });
    });
  });

  describe('error envelope exemption (AC2 vs API-100-05)', () => {
    it('the 503 body is exactly {"status","failed"}: the envelope filter does not rewrite it', async () => {
      redis.ping.mockRejectedValue(new Error('down'));
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      const body = res.json<Record<string, unknown>>();
      expect(Object.keys(body)).toEqual(['status', 'failed']);
      expect(body).not.toHaveProperty('error');
      // No "unexpected error" line: the filter never saw this response.
      await settle();
      expect(logs.lines.map((l) => l.msg)).not.toContain('unexpected error');
    });

    it('other errors still use the envelope', async () => {
      const res = await app.inject({ method: 'GET', url: '/no-such-root-route' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toHaveProperty('error.code');
    });
  });

  describe('public and not rate limited (AC3)', () => {
    it.each(['healthz', 'readyz'] as const)(
      '%s is marked @Public() and @SkipRateLimit()',
      (name) => {
        const reflector = app.get(Reflector);
        const context = {
          getHandler: () => handlerOf(name),
          getClass: () => HealthController,
        } as unknown as ExecutionContext;
        expect(isPublicRoute(reflector, context)).toBe(true);
        expect(skipsRateLimit(reflector, context)).toBe(true);
      },
    );

    it('answers without an Authorization header', async () => {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    });
  });

  describe('logging (AC3)', () => {
    it.each(['/healthz', '/readyz'])('%s writes no info line per call', async (url) => {
      await app.inject({ method: 'GET', url });
      await app.inject({ method: 'GET', url });
      await settle();
      expect(logs.lines.filter((l) => l.msg === 'request completed')).toEqual([]);
    });

    it('a 503 readyz writes no per-call error line either', async () => {
      redis.ping.mockRejectedValue(new Error('down'));
      await app.inject({ method: 'GET', url: '/readyz' });
      await settle();
      expect(logs.lines.filter((l) => l.msg === 'request completed')).toEqual([]);
    });

    it('ordinary routes still log at info', async () => {
      await app.inject({ method: 'GET', url: '/v1/no-such-route' });
      await settle();
      expect(logs.lines.filter((l) => l.msg === 'request completed')).toHaveLength(1);
    });

    it('logs the completion line at debug when LOG_LEVEL=debug', async () => {
      const root = app.get<Logger>(ROOT_LOGGER);
      const previous = root.level;
      root.level = 'debug';
      try {
        await app.inject({ method: 'GET', url: '/healthz' });
        await settle();
        const done = logs.lines.filter((l) => l.msg === 'request completed');
        expect(done).toHaveLength(1);
        expect(done[0]).toMatchObject({ level: 'debug', route: '/healthz', status_code: 200 });
      } finally {
        root.level = previous;
      }
    });

    it('logs readiness only when it changes (warn when unavailable, info when ready again)', async () => {
      // Establish a known state first.
      await app.inject({ method: 'GET', url: '/readyz' });
      logs.raw.length = 0;

      redis.ping.mockRejectedValue(new Error('down'));
      await app.inject({ method: 'GET', url: '/readyz' });
      await app.inject({ method: 'GET', url: '/readyz' });
      redis.ping.mockResolvedValue(undefined);
      await app.inject({ method: 'GET', url: '/readyz' });
      await app.inject({ method: 'GET', url: '/readyz' });
      await settle();

      const changes = logs.lines.filter((l) => String(l.msg).startsWith('readiness:'));
      expect(changes).toHaveLength(2);
      expect(changes[0]).toMatchObject({
        level: 'warn',
        msg: 'readiness: unavailable',
        failed: ['redis'],
        reasons: { redis: 'down' },
      });
      expect(changes[1]).toMatchObject({ level: 'info', msg: 'readiness: ready' });
    });
  });
});

describe('Readiness with no data store URLs (development/test)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // Unit tests run with DATABASE_URL / REDIS_URL removed (src/testing/unit-env.ts).
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots, /healthz answers 200 and /readyz reports db and redis as failed', async () => {
    expect(app.get(DatabaseService).isConfigured).toBe(false);
    expect(app.get(RedisService).isConfigured).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ status: string; failed: string[] }>();
    expect(body.status).toBe('unavailable');
    // "migrations" also fails here once db/migrations/ has files (the lookup needs the database).
    expect(body.failed.slice(0, 2)).toEqual(['db', 'redis']);
  });

  it('the services refuse use when not configured', async () => {
    expect(() => app.get(DatabaseService).db).toThrow(DataStoreNotConfiguredError);
    await expect(app.get(DatabaseService).query('select 1')).rejects.toThrow('DATABASE_URL');
    expect(() => app.get(RedisService).client).toThrow(DataStoreNotConfiguredError);
  });
});
