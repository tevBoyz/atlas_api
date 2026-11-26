import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { authHeader } from '../../src/testing/test-tokens';
import {
  createAuthApp,
  DEVICE,
  errorOf,
  post,
  legacyUser,
  type SessionBody,
  signedUpUser,
} from '../support/auth-api';
import { openTestClient } from '../support/database';
import { goneUser } from '../support/test-sessions';
import { fakePushToken } from '../support/device-api';

/**
 * API-100-56: rotating refresh tokens (SHA-256 at rest, 30-day lifetime, reuse revokes the session,
 * D7's 7-day idle limit), sign-out of one device (push token cleared) and of every device, the
 * session list and delete (own only), and `GET /v1/me`.
 */
describe('refresh rotation, device sessions and sign-out (API-100-56)', () => {
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

  const refresh = (token: unknown) => post(app, '/v1/auth/refresh', { refresh_token: token });
  const bearer = (session: SessionBody) => ({ authorization: `Bearer ${session.access_token}` });
  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });

  async function sessionRow(id: string) {
    const { rows } = await client.query<{ revoked: boolean; revoke_reason: string | null }>(
      `select revoked_at is not null as revoked, revoke_reason from public.device_sessions where id = $1`,
      [id],
    );
    return rows[0];
  }

  /** A second session of the same user (a sign-in on another phone). */
  async function anotherSession(email: string, password: string, device = DEVICE) {
    const res = await post(app, '/v1/auth/login', { email, password, device });
    expect(res.statusCode).toBe(200);
    return res.json<SessionBody>();
  }

  describe('A11 POST /v1/auth/refresh', () => {
    it('rotates: a new access and refresh token in the same session; the old token is used up', async () => {
      const { session } = await signedUpUser(app);
      const res = await refresh(session.refresh_token);
      expect(res.statusCode).toBe(200);
      const next = res.json<SessionBody>();
      expect(next.session_id).toBe(session.session_id);
      expect(next.refresh_token).not.toBe(session.refresh_token);
      expect(next.user.id).toBe(session.user.id);
      expect(
        Math.round((Date.parse(next.refresh_token_expires_at) - Date.now()) / 86_400_000),
      ).toBe(7);
      expect((await get('/v1/me', bearer(next))).statusCode).toBe(200);
      const { rows } = await client.query<{ used: boolean; parent: boolean; days: number }>(
        `select used_at is not null as used, parent_id is not null as parent,
                round(extract(epoch from expires_at - issued_at) / 86400)::int as days
           from public.refresh_tokens where session_id = $1 order by issued_at`,
        [session.session_id],
      );
      expect(rows).toEqual([
        { used: true, parent: false, days: 30 },
        { used: false, parent: true, days: 30 },
      ]);
      const { rows: stored } = await client.query<{ n: number }>(
        `select count(*)::int as n from public.refresh_tokens
          where encode(token_hash, 'escape') like '%' || $1 || '%'`,
        [session.refresh_token.slice(0, 20)],
      );
      expect(stored[0].n).toBe(0);
    });

    it('reuse of a used token revokes the whole session: 401 refresh_token_reused, then everything fails', async () => {
      const { session } = await signedUpUser(app);
      const next = (await refresh(session.refresh_token)).json<SessionBody>();
      const reused = await refresh(session.refresh_token);
      expect([reused.statusCode, errorOf(reused).code]).toEqual([401, 'auth:refresh_token_reused']);
      expect(await sessionRow(session.session_id)).toEqual({
        revoked: true,
        revoke_reason: 'refresh_token_reused',
      });
      const latest = await refresh(next.refresh_token);
      expect([latest.statusCode, errorOf(latest).code]).toEqual([401, 'auth:session_expired']);
      expect((await get('/v1/me', bearer(next))).statusCode).toBe(401);
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from public.audit_log
          where action = 'auth.refresh.reuse_detected' and target_id = $1`,
        [session.session_id],
      );
      expect(rows[0].n).toBe(1);
    });

    it('two refreshes racing with one token: one wins, the other is a reuse', async () => {
      const { session } = await signedUpUser(app);
      const replies = await Promise.all([
        refresh(session.refresh_token),
        refresh(session.refresh_token),
      ]);
      expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    });

    it('D7: a session not refreshed for 7 days ends (revoked, 401 session_expired); so does an expired token', async () => {
      const a = (await signedUpUser(app)).session;
      await client.query(
        `update public.device_sessions set last_refreshed_at = now() - interval '7 days 1 minute' where id = $1`,
        [a.session_id],
      );
      const idle = await refresh(a.refresh_token);
      expect([idle.statusCode, errorOf(idle).code]).toEqual([401, 'auth:session_expired']);
      expect(await sessionRow(a.session_id)).toEqual({ revoked: true, revoke_reason: 'idle' });

      const b = (await signedUpUser(app)).session;
      await client.query(
        `update public.refresh_tokens set expires_at = now() - interval '1 second' where session_id = $1`,
        [b.session_id],
      );
      expect(errorOf(await refresh(b.refresh_token)).code).toBe('auth:session_expired');
    });

    it('unknown or malformed tokens → 401 auth:session_expired', async () => {
      for (const token of ['x'.repeat(43), 'not a token', 7, '']) {
        const res = await refresh(token);
        expect([res.statusCode, errorOf(res).code]).toEqual([401, 'auth:session_expired']);
      }
    });
  });

  describe('A12 / A13 sign-out', () => {
    it('logout ends this session only and clears its device push token (linked by U1)', async () => {
      const { email, password, session } = await legacyUser(app, client);
      const installation = randomUUID();
      const push = fakePushToken('logout');
      const u1 = await app.inject({
        method: 'PUT',
        url: '/v1/me/devices/current',
        headers: {
          ...bearer(session),
          'x-atlas-installation-id': installation,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          platform: 'android',
          app_version: '1.0.0',
          push_provider: 'fcm',
          push_token: push,
        }),
      });
      expect(u1.statusCode).toBe(200);
      const deviceId = u1.json<{ device_id: string }>().device_id;
      const { rows: linked } = await client.query<{ device_id: string }>(
        'select device_id::text from public.device_sessions where id = $1',
        [session.session_id],
      );
      expect(linked[0].device_id).toBe(deviceId);
      const other = await anotherSession(email, password);

      const res = await post(app, '/v1/auth/logout', {}, bearer(session));
      expect(res.statusCode).toBe(204);
      expect(await sessionRow(session.session_id)).toEqual({
        revoked: true,
        revoke_reason: 'logout',
      });
      const { rows } = await client.query<{ push_token: string | null }>(
        'select push_token from public.user_devices where id = $1',
        [deviceId],
      );
      expect(rows[0].push_token).toBeNull();
      expect((await get('/v1/me', bearer(session))).statusCode).toBe(401);
      expect(errorOf(await refresh(session.refresh_token)).code).toBe('auth:session_expired');
      expect((await get('/v1/me', bearer(other))).statusCode).toBe(200);
    });

    it('a session opened with X-Atlas-Installation-Id is linked to that device at sign-in', async () => {
      const { email, password, session } = await legacyUser(app, client);
      const installation = randomUUID();
      await app.inject({
        method: 'PUT',
        url: '/v1/me/devices/current',
        headers: {
          ...bearer(session),
          'x-atlas-installation-id': installation,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          platform: 'ios',
          app_version: '2.0.0',
          push_provider: 'apns',
          push_token: fakePushToken('ios'),
        }),
      });
      const res = await post(
        app,
        '/v1/auth/login',
        { email, password, device: DEVICE },
        { 'x-atlas-installation-id': installation },
      );
      const second = res.json<SessionBody>();
      const { rows } = await client.query<{ linked: boolean; installation_id: string }>(
        `select device_id is not null as linked, installation_id from public.device_sessions where id = $1`,
        [second.session_id],
      );
      expect(rows[0]).toEqual({ linked: true, installation_id: installation });
      expect((await post(app, '/v1/auth/logout', {}, bearer(second))).statusCode).toBe(204);
      const { rows: devices } = await client.query<{ push_token: string | null }>(
        'select push_token from public.user_devices where installation_id = $1',
        [installation],
      );
      expect(devices[0].push_token).toBeNull();
    });

    it('logout-all ends every session of the user and clears every device push token', async () => {
      const { email, password, session } = await legacyUser(app, client);
      const other = await anotherSession(email, password);
      await app.inject({
        method: 'PUT',
        url: '/v1/me/devices/current',
        headers: {
          ...bearer(other),
          'x-atlas-installation-id': randomUUID(),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          platform: 'android',
          app_version: '1',
          push_provider: 'fcm',
          push_token: fakePushToken('all'),
        }),
      });
      expect((await post(app, '/v1/auth/logout-all', {}, bearer(session))).statusCode).toBe(204);
      for (const id of [session.session_id, other.session_id]) {
        expect(await sessionRow(id)).toEqual({ revoked: true, revoke_reason: 'logout_all' });
      }
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from public.user_devices where user_id = $1 and push_token is not null`,
        [session.user.id],
      );
      expect(rows[0].n).toBe(0);
      expect((await get('/v1/me', bearer(other))).statusCode).toBe(401);
    });

    it('sign-out needs an access token (401 auth:not_authenticated)', async () => {
      const anonymous = await post(app, '/v1/auth/logout', {});
      expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([
        401,
        'auth:not_authenticated',
      ]);
    });
  });

  describe('A17 GET /v1/me and A19 / A20 sessions', () => {
    it('GET /v1/me answers the User (imported accounts too); a deleted account answers 401', async () => {
      const { session } = await signedUpUser(app);
      const res = await get('/v1/me', bearer(session));
      expect(res.json()).toEqual(session.user);
      const imported = await legacyUser(app, client);
      const own = await get('/v1/me', bearer(imported.session));
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({
        id: imported.id,
        email: imported.email,
        identities: [
          { provider: 'email', created_at: expect.any(String) as string },
          { provider: 'phone', created_at: expect.any(String) as string },
        ],
      });
      const unknown = await get('/v1/me', await authHeader(await goneUser(client)));
      expect([unknown.statusCode, errorOf(unknown).code]).toEqual([401, 'auth:not_authenticated']);
    });

    it('lists live sessions with `current`; deletes own sessions only (404 for anything else)', async () => {
      const { email, password, session } = await signedUpUser(app);
      const phone2 = await anotherSession(email, password, {
        platform: 'ios',
        app_version: '3.1',
        device_name: 'iPhone',
      } as never);
      const list = await get('/v1/me/sessions', bearer(session));
      expect(list.statusCode).toBe(200);
      const entries =
        list.json<
          { id: string; current: boolean; platform: string; device_name: string | null }[]
        >();
      expect(entries.map((e) => [e.id, e.current]).sort()).toEqual(
        [
          [session.session_id, true],
          [phone2.session_id, false],
        ].sort(),
      );
      expect(entries.find((e) => e.id === phone2.session_id)).toMatchObject({
        platform: 'ios',
        device_name: 'iPhone',
      });
      expect(Object.keys(entries[0]).sort()).toEqual([
        'created_at',
        'current',
        'device_name',
        'id',
        'last_seen_at',
        'platform',
      ]);

      const stranger = await signedUpUser(app);
      const foreign = await app.inject({
        method: 'DELETE',
        url: `/v1/me/sessions/${stranger.session.session_id}`,
        headers: bearer(session),
      });
      expect([foreign.statusCode, errorOf(foreign).code]).toEqual([404, 'auth:session_not_found']);
      for (const id of [randomUUID(), 'not-a-uuid']) {
        const res = await app.inject({
          method: 'DELETE',
          url: `/v1/me/sessions/${id}`,
          headers: bearer(session),
        });
        expect([res.statusCode, errorOf(res).code]).toEqual([404, 'auth:session_not_found']);
      }
      const del = await app.inject({
        method: 'DELETE',
        url: `/v1/me/sessions/${phone2.session_id}`,
        headers: bearer(session),
      });
      expect(del.statusCode).toBe(204);
      expect(await sessionRow(phone2.session_id)).toEqual({
        revoked: true,
        revoke_reason: 'deleted',
      });
      const again = await app.inject({
        method: 'DELETE',
        url: `/v1/me/sessions/${phone2.session_id}`,
        headers: bearer(session),
      });
      expect(again.statusCode).toBe(404);
      const after = (await get('/v1/me/sessions', bearer(session))).json<{ id: string }[]>();
      expect(after.map((e) => e.id)).toEqual([session.session_id]);
      expect((await get('/v1/me', bearer(stranger.session))).statusCode).toBe(200);
    });
  });
});
