import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AccessTokenSigner } from '../../src/modules/auth/access-tokens';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import { createUser, type UserFixture } from '../support/fixtures';
import { connectSocket } from '../support/realtime-client';

/**
 * API-100-51 against a real database: the guard accepts the API's own access tokens on every route
 * (REST and the realtime handshake) while the session is live, refuses them once
 * `device_sessions.revoked_at` is set or the user is disabled, publishes the public keys, and accepts
 * Supabase tokens only while SUPABASE_JWT_ACCEPT=true.
 */
describe('own access tokens and the dual-token guard (API-100-51)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let signer: AccessTokenSigner;
  let user: UserFixture;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    signer = app.get(AccessTokenSigner);
    client = await openTestClient();
    user = await createUser(client);
    await client.query(
      'insert into public.users (id, email, email_confirmed_at) values ($1, $2, now())',
      [user.id, user.email],
    );
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  async function newSession(userId = user.id): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.device_sessions (user_id, auth_method, platform, app_version)
       values ($1, 'password', 'android', '1.0.0') returning id`,
      [userId],
    );
    return rows[0].id;
  }

  const openIncident = (authorization: string) =>
    app.inject({ method: 'GET', url: '/v1/me/incidents/open', headers: { authorization } });

  it('AC1: GET /v1/auth/.well-known/jwks.json publishes the active public key (no private part)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const { keys } = res.json<{ keys: Record<string, string>[] }>();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      kid: process.env.AUTH_JWT_ACTIVE_KID,
      alg: 'EdDSA',
      use: 'sig',
      kty: 'OKP',
    });
    expect(keys[0]).not.toHaveProperty('d');
    expect(res.body).not.toContain(
      (JSON.parse(process.env.AUTH_JWT_KEYS!) as { d: string }[])[0].d,
    );
  });

  it('AC3: an own token of a live session is accepted on an authenticated route', async () => {
    const sid = await newSession();
    const { token } = await signer.issue(user.id, sid);
    const res = await openIncident(`Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ open_incident: null });
  });

  it('AC3: a revoked session is refused with the route parity code (401)', async () => {
    const sid = await newSession();
    const { token } = await signer.issue(user.id, sid);
    expect((await openIncident(`Bearer ${token}`)).statusCode).toBe(200);
    await client.query(
      `update public.device_sessions set revoked_at = now(), revoke_reason = 'logout' where id = $1`,
      [sid],
    );
    const res = await openIncident(`Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      'get_my_open_incident:not_authenticated',
    );
  });

  it('AC3: a session of another user, an unknown session and a disabled user are refused', async () => {
    const other = await createUser(client);
    await client.query('insert into public.users (id) values ($1)', [other.id]);
    const otherSid = await newSession(other.id);
    expect(
      (await openIncident(`Bearer ${(await signer.issue(user.id, otherSid)).token}`)).statusCode,
    ).toBe(401);
    expect(
      (await openIncident(`Bearer ${(await signer.issue(user.id, randomUUID())).token}`))
        .statusCode,
    ).toBe(401);
    const sid = await newSession(other.id);
    const { token } = await signer.issue(other.id, sid);
    expect((await openIncident(`Bearer ${token}`)).statusCode).toBe(200);
    await client.query('update public.users set disabled_at = now() where id = $1', [other.id]);
    expect((await openIncident(`Bearer ${token}`)).statusCode).toBe(401);
  });

  it('AC3: Supabase tokens are accepted while SUPABASE_JWT_ACCEPT=true (the default)', async () => {
    const res = await openIncident((await authHeader(user.id)).authorization);
    expect(res.statusCode).toBe(200);
  });

  it('AC3: the realtime handshake accepts an own token of a live session and refuses a revoked one', async () => {
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const sid = await newSession();
    const { token } = await signer.issue(user.id, sid);
    const socket = await connectSocket(base, user.id, { auth: { token } });
    expect(socket.socket.connected).toBe(true);
    socket.close();
    await client.query(
      `update public.device_sessions set revoked_at = now(), revoke_reason = 'logout' where id = $1`,
      [sid],
    );
    await expect(connectSocket(base, user.id, { auth: { token } })).rejects.toMatchObject({
      data: { code: 'auth:session_expired' },
    });
  });

  describe('SUPABASE_JWT_ACCEPT=false', () => {
    let closed: NestFastifyApplication;

    beforeAll(async () => {
      ({ app: closed } = await createTestApp({}, withTestConfig({ SUPABASE_JWT_ACCEPT: 'false' })));
    });

    afterAll(async () => {
      await closed.close();
    });

    it('refuses Supabase tokens and still accepts own tokens', async () => {
      const supabase = await closed.inject({
        method: 'GET',
        url: '/v1/me/incidents/open',
        headers: await authHeader(user.id),
      });
      expect(supabase.statusCode).toBe(401);
      const sid = await newSession();
      const { token } = await closed.get(AccessTokenSigner).issue(user.id, sid);
      const own = await closed.inject({
        method: 'GET',
        url: '/v1/me/incidents/open',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(own.statusCode).toBe(200);
    });
  });
});
