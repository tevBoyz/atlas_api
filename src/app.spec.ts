import { randomUUID } from 'node:crypto';

import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { type AuthenticatedUser, CurrentUser } from './common/auth';
import { Operation } from './common/errors';
import { FEATURE_MODULES } from './modules';
import { createTestApp } from './testing/test-app';
import { authHeader, withTestSessions } from './testing/test-tokens';

/** Test-only route: proves the `/v1` prefix and authentication without touching a data store. */
@Controller('test-app')
class WhoAmIController {
  @Get('whoami')
  @Operation('get_my_open_incident')
  whoami(@CurrentUser() user: AuthenticatedUser) {
    return { user_id: user.id };
  }
}

describe('App scaffold (API-100-01)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({ controllers: [WhoAmIController] }, withTestSessions));
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
      url: '/v1/test-app/whoami',
      headers: await authHeader(userId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user_id: userId });
  });

  it('answers 401 with the operation code on a /v1 route without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/test-app/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      'get_my_open_incident:not_authenticated',
    );
  });

  it('does not serve REST routes without the /v1 prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-app/whoami' });
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
