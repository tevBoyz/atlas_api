import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { ApiConfigService, type ConfigKey, parseConfig } from '../../src/config';
import { createTestApp } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { DEVICE, errorOf, signedUpUser, untilReady } from '../support/auth-api';
import { openTestClient } from '../support/database';
import { createUser } from '../support/fixtures';

/**
 * Stage 7.1d (D40): `SUPABASE_JWT_ACCEPT` defaults to false. With the variable unset, a valid
 * Supabase access token is refused on every route (REST and the exchange), while own tokens work;
 * set to true it is accepted again (the other suites set it, `test/support/worker-env.ts`).
 */
describe('Supabase access tokens are off by default (stage 7.1d, D40)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CHANNEL_EMAIL_ENABLED: 'true',
      DATABASE_POOL_MAX: '5',
    };
    delete env.SUPABASE_JWT_ACCEPT;
    delete env.SUPABASE_JWT_ACCEPT_UNTIL;
    const config = parseConfig(env);
    expect(config.SUPABASE_JWT_ACCEPT).toBe(false);
    ({ app } = await createTestApp({}, (builder) =>
      builder.overrideProvider(ApiConfigService).useValue({
        get: (key: ConfigKey) => config[key],
        isProduction: false,
      }),
    ));
    await untilReady(app);
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  it('a valid Supabase token is refused (401) on REST routes and on the exchange', async () => {
    const user = await createUser(client);
    const headers = await authHeader(user.id, { claims: { session_id: randomUUID() } });
    for (const url of ['/v1/me', '/v1/me/profile', '/v1/me/circle']) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect([url, res.statusCode]).toEqual([url, 401]);
    }
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/auth/exchange',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ device: DEVICE }),
    });
    expect([exchange.statusCode, errorOf(exchange).code]).toEqual([401, 'auth:not_authenticated']);
  });

  it('own access tokens still work', async () => {
    const { session } = await signedUpUser(app);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect([res.statusCode, res.json<{ id: string }>().id]).toEqual([200, session.user.id]);
  });
});
