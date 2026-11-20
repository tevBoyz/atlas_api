import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ApiConfigService, type ConfigKey, parseConfig } from '../../src/config';
import { DatabaseService } from '../../src/db';
import { EXPECTED_MIGRATIONS } from '../../src/health/expected-migrations';
import { READINESS_CHECK_TIMEOUT_MS } from '../../src/health/readiness';
import { RedisService } from '../../src/redis';
import { createTestApp } from '../../src/testing/test-app';

/**
 * Health and readiness against the test containers (API-100-07, API-100-13).
 *
 * Unreachable stores are simulated with closed local ports (127.0.0.1:1), never by touching the
 * running containers.
 */

const CLOSED_PORT_DB = 'postgresql://postgres:postgres@127.0.0.1:1/postgres';
const CLOSED_PORT_REDIS = 'redis://127.0.0.1:1';

/** Redis (main client or the realtime adapter's) still connecting in the background. */
function redisPending(failed: string[]): boolean {
  return failed.includes('redis') || failed.includes('realtime');
}

/** An app whose config is the environment plus `overrides` (validated like the real one). */
async function appWith(
  overrides: Record<string, string>,
  expected?: { ids: string[] },
): Promise<NestFastifyApplication> {
  const config = parseConfig({ ...process.env, LOG_LEVEL: 'silent', ...overrides });
  const { app } = await createTestApp({}, (builder) => {
    const next = builder
      .overrideProvider(ApiConfigService)
      .useValue({ get: (key: ConfigKey) => config[key], isProduction: false });
    return expected ? next.overrideProvider(EXPECTED_MIGRATIONS).useValue(expected) : next;
  });
  return app;
}

describe('Health and readiness against local Postgres and Redis (API-100-07)', () => {
  describe('healthy stack', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      ({ app } = await createTestApp());
    });

    afterAll(async () => {
      await app.close();
    });

    it('connects to the local stores', async () => {
      expect(app.get(DatabaseService).isConfigured).toBe(true);
      expect(app.get(RedisService).isConfigured).toBe(true);
      await expect(app.get(DatabaseService).ping()).resolves.toBeUndefined();
    });

    it('GET /healthz → 200 {"status":"ok"}', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    });

    it('GET /readyz → 200 {"status":"ok"} (DB query, Redis PING, migrations, realtime adapter)', async () => {
      // Redis connects in the background after startup; give it a moment on a slow machine.
      let res = await app.inject({ method: 'GET', url: '/readyz' });
      for (let i = 0; i < 20 && res.statusCode !== 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        res = await app.inject({ method: 'GET', url: '/readyz' });
      }
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    });

    it('drizzle runs queries over the pool', async () => {
      const result = await app.get(DatabaseService).db.execute('select 1 as one');
      expect(result.rows).toEqual([{ one: 1 }]);
    });
  });

  describe('a migration this build expects is not recorded', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await appWith({}, { ids: ['9999_readyz_int_never_applied'] });
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /readyz → 503 failed ["migrations"]', async () => {
      // Wait for Redis to be connected so only the migrations check fails.
      let res = await app.inject({ method: 'GET', url: '/readyz' });
      for (let i = 0; i < 20 && redisPending(res.json<{ failed: string[] }>().failed); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        res = await app.inject({ method: 'GET', url: '/readyz' });
      }
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'unavailable', failed: ['migrations'] });
    });
  });

  describe('Redis unreachable', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await appWith({ REDIS_URL: CLOSED_PORT_REDIS });
    });

    afterAll(async () => {
      await app.close();
    });

    it('/healthz still 200; /readyz → 503 failed ["redis","realtime"] within the timeout', async () => {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const started = Date.now();
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(Date.now() - started).toBeLessThan(READINESS_CHECK_TIMEOUT_MS + 500);
      expect(res.statusCode).toBe(503);
      expect(res.body).toBe('{"status":"unavailable","failed":["redis","realtime"]}');
    });
  });

  describe('Postgres unreachable', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await appWith({ DATABASE_URL: CLOSED_PORT_DB }, { ids: ['0001_any'] });
    });

    afterAll(async () => {
      await app.close();
    });

    it('/healthz still 200; /readyz → 503 failed ["db","migrations"] within the timeout', async () => {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      let res = await app.inject({ method: 'GET', url: '/readyz' });
      for (let i = 0; i < 20 && redisPending(res.json<{ failed: string[] }>().failed); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        res = await app.inject({ method: 'GET', url: '/readyz' });
      }
      const started = Date.now();
      res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(Date.now() - started).toBeLessThan(READINESS_CHECK_TIMEOUT_MS + 500);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'unavailable', failed: ['db', 'migrations'] });
    });
  });
});
