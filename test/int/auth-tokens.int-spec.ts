import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SignJWT } from 'jose';
import type { Client } from 'pg';

import { AccessTokenSigner } from '../../src/modules/auth/access-tokens';
import { createTestApp } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import { createUser, type UserFixture } from '../support/fixtures';
import { connectSocket } from '../support/realtime-client';

/**
 * API-100-51 against a real database: the guard accepts the API's own access tokens on every route
 * (REST and the realtime handshake) while the session is live, refuses them once
 * `device_sessions.revoked_at` is set or the user is disabled, publishes the public keys, and refuses
 * Supabase-issued tokens (retired with the old backend, D76).
 */
describe('own access tokens and the guard (API-100-51, D76)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let signer: AccessTokenSigner;
  let user: UserFixture;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    signer = app.get(AccessTokenSigner);
    client = await openTestClient();
    // The fixture's profile moves the user into users (migration 0010, D37).
    user = await createUser(client);
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

  it('AC3: the test token factory signs own tokens the guard accepts', async () => {
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

  it('D76: a Supabase-shaped HS256 access token is refused (401), own tokens still pass', async () => {
    const supabaseLike = await new SignJWT({ role: 'authenticated', session_id: randomUUID() })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('http://127.0.0.1:54321/auth/v1')
      .setAudience('authenticated')
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('x'.repeat(40)));
    const res = await openIncident(`Bearer ${supabaseLike}`);
    expect(res.statusCode).toBe(401);
    const sid = await newSession();
    const { token } = await signer.issue(user.id, sid);
    expect((await openIncident(`Bearer ${token}`)).statusCode).toBe(200);
  });
});
