import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { randomUUID } from 'node:crypto';

import { FEATURE_MODULES } from './modules';
import { createTestApp } from './testing/test-app';
import { authHeader } from './testing/test-tokens';

describe('App scaffold (API-100-01)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers all eleven feature modules', () => {
    expect(FEATURE_MODULES).toHaveLength(11);
    for (const mod of FEATURE_MODULES) {
      expect(app.get(mod)).toBeInstanceOf(mod);
    }
  });

  it('serves REST routes under /v1 (authenticated since API-100-08)', async () => {
    const userId = randomUUID();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: await authHeader(userId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', user_id: userId });
  });

  it('answers 401 ping:not_authenticated on /v1/ping without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ping' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ping:not_authenticated');
  });

  it('does not serve REST routes without the /v1 prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(404);
  });

  it('serves the health route without the prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('does not serve the health route under /v1', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/healthz' });
    expect(res.statusCode).toBe(404);
  });
});
