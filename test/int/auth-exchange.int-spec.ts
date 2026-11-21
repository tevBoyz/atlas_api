import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import type { Client } from 'pg';

import { TOKEN_USAGE, type TokenUsageMetrics } from '../../src/common/auth';
import { readUsage } from '../../src/modules/auth/tooling/token-usage-report';
import { authHeader } from '../../src/testing/test-tokens';
import { createAuthApp, DEVICE, errorOf, post, type SessionBody } from '../support/auth-api';
import { openTestClient } from '../support/database';
import { createUser } from '../support/fixtures';

/**
 * API-100-59 AC1/AC2: the one-time exchange of a Supabase session for an API session (D8), the
 * dual-token window with the share of Supabase tokens counted per day, and switching Supabase
 * tokens off by config (SUPABASE_JWT_ACCEPT, SUPABASE_JWT_ACCEPT_UNTIL).
 */
describe('session exchange and the dual-token window (API-100-59)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createAuthApp());
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const exchange = (headers: Record<string, string>) =>
    post(app, '/v1/auth/exchange', { device: DEVICE }, headers);

  it('AC1: a Supabase session becomes an API session once (same user id, moved from auth.users)', async () => {
    const legacy = await createUser(client, { phone: true });
    const supabaseSession = randomUUID();
    const headers = await authHeader(legacy.id, { claims: { session_id: supabaseSession } });
    const res = await exchange(headers);
    expect(res.statusCode).toBe(200);
    const session = res.json<SessionBody>();
    expect(session.user).toMatchObject({ id: legacy.id, email: legacy.email, phone: legacy.phone });
    const { rows } = await client.query<{ auth_method: string; exchanged: string }>(
      `select auth_method, exchanged_supabase_session_id::text as exchanged
         from public.device_sessions where id = $1`,
      [session.session_id],
    );
    expect(rows[0]).toEqual({ auth_method: 'exchange', exchanged: supabaseSession });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${session.access_token}` },
        })
      ).statusCode,
    ).toBe(200);
    const again = await exchange(headers);
    expect([again.statusCode, errorOf(again).code]).toEqual([
      409,
      'auth:session_already_exchanged',
    ]);
    const { rows: audit } = await client.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log where action = 'auth.session.exchanged' and actor_user_id = $1`,
      [legacy.id],
    );
    expect(audit[0].n).toBe(1);
  });

  it('AC1: two exchanges of one Supabase session at once: one session, one 409', async () => {
    const legacy = await createUser(client);
    const headers = await authHeader(legacy.id, { claims: { session_id: randomUUID() } });
    const replies = await Promise.all([exchange(headers), exchange(headers), exchange(headers)]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
  });

  it('AC1: an API token, a Supabase token without a session, or no token cannot be exchanged', async () => {
    const legacy = await createUser(client);
    const first = (
      await exchange(await authHeader(legacy.id, { claims: { session_id: randomUUID() } }))
    ).json<SessionBody>();
    const own = await exchange({ authorization: `Bearer ${first.access_token}` });
    expect([own.statusCode, errorOf(own).code]).toEqual([403, 'auth:exchange_not_allowed']);
    const noSession = await exchange(
      await authHeader(legacy.id, { claims: { session_id: undefined } }),
    );
    expect([noSession.statusCode, errorOf(noSession).code]).toEqual([
      403,
      'auth:exchange_not_allowed',
    ]);
    const anonymous = await exchange({});
    expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([
      401,
      'auth:not_authenticated',
    ]);
    const unknown = await exchange(
      await authHeader(randomUUID(), { claims: { session_id: randomUUID() } }),
    );
    expect([unknown.statusCode, errorOf(unknown).code]).toEqual([401, 'auth:not_authenticated']);
  });

  it('AC2: every accepted token counts per issuer and UTC day (requests and distinct users)', async () => {
    const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true });
    await redis.connect();
    try {
      const usage = app.get<TokenUsageMetrics>(TOKEN_USAGE);
      await usage.flush();
      const before = (await readUsage(redis, 1))[0];
      const legacy = await createUser(client);
      const supabase = await authHeader(legacy.id, { claims: { session_id: randomUUID() } });
      for (let i = 0; i < 3; i += 1)
        await app.inject({ method: 'GET', url: '/v1/me', headers: supabase });
      const own = (await exchange(supabase)).json<SessionBody>();
      await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${own.access_token}` },
      });
      await usage.flush();
      const after = (await readUsage(redis, 1))[0];
      expect(after.supabase_requests - before.supabase_requests).toBe(4);
      expect(after.atlas_requests - before.atlas_requests).toBe(1);
      expect(after.supabase_users).toBeGreaterThanOrEqual(1);
      expect(after.atlas_users).toBeGreaterThanOrEqual(1);
      expect(after.supabase_share).toBeGreaterThan(0);
      const keys = await redis.keys('atlas:auth:token-usage:v1:*');
      for (const key of keys) expect(key).not.toContain(legacy.id);
    } finally {
      await redis.quit();
    }
  });

  describe('AC2: Supabase acceptance switched off by config', () => {
    let off: NestFastifyApplication;
    let past: NestFastifyApplication;

    beforeAll(async () => {
      ({ app: off } = await createAuthApp({ SUPABASE_JWT_ACCEPT: 'false' }));
      ({ app: past } = await createAuthApp({ SUPABASE_JWT_ACCEPT_UNTIL: '2026-01-01T00:00:00Z' }));
    });

    afterAll(async () => {
      await Promise.all([off.close(), past.close()]);
    });

    it.each(['SUPABASE_JWT_ACCEPT=false', 'SUPABASE_JWT_ACCEPT_UNTIL in the past'])(
      '%s: Supabase tokens get 401 (no exchange either); own tokens still work',
      async (label) => {
        const target = label.startsWith('SUPABASE_JWT_ACCEPT=') ? off : past;
        const legacy = await createUser(client);
        const supabase = await authHeader(legacy.id, { claims: { session_id: randomUUID() } });
        const res = await target.inject({ method: 'GET', url: '/v1/me', headers: supabase });
        expect([res.statusCode, errorOf(res).code]).toEqual([401, 'auth:not_authenticated']);
        const ex = await post(target, '/v1/auth/exchange', { device: DEVICE }, supabase);
        expect(ex.statusCode).toBe(401);
        const own = (
          await exchange(await authHeader(legacy.id, { claims: { session_id: randomUUID() } }))
        ).json<SessionBody>();
        const ok = await target.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${own.access_token}` },
        });
        expect(ok.statusCode).toBe(200);
      },
    );
  });
});
