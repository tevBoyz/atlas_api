import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { DatabaseService } from '../../src/db/database.service';
import { AuditService } from '../../src/modules/audit';
import { DeliveriesRepository } from '../../src/modules/notifications/deliveries.repository';
import { pushTokenHash } from '../../src/modules/notifications/device-input';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import { clearDevicePushToken, fakePushToken, registerDevice } from '../support/device-api';
import { createUser, type UserFixture } from '../support/fixtures';

/**
 * Device registration (API-100-44, spec §11.3 U1/U2, D22): upsert per (user, installation), the push
 * token moving between devices, clearing it at sign-out, Supabase tokens, validation order, and that
 * a push token never reaches a log line, an error body or the audit log.
 */
type Body = Record<string, unknown>;

interface DeviceRow {
  id: string;
  user_id: string;
  installation_id: string;
  platform: string;
  app_version: string | null;
  push_provider: string | null;
  push_token: string | null;
  push_token_updated_at: Date | null;
  push_token_invalid_hash: string | null;
  created_at: Date;
  last_seen_at: Date;
}

const PARALLEL = 20;

describe('PUT /v1/me/devices/current and DELETE .../push-token (API-100-44)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;
  const tokensUsed: string[] = [];

  beforeAll(async () => {
    ({ app, logs } = await createTestApp(
      {},
      withTestConfig({ DATABASE_POOL_MAX: String(PARALLEL + 5) }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function token(label?: string): string {
    const value = fakePushToken(label);
    tokensUsed.push(value);
    return value;
  }

  async function rowsOf(userId: string): Promise<DeviceRow[]> {
    const { rows } = await client.query<DeviceRow>(
      'select * from public.user_devices where user_id = $1 order by created_at, id',
      [userId],
    );
    return rows;
  }

  async function rowWithToken(value: string): Promise<DeviceRow[]> {
    const { rows } = await client.query<DeviceRow>(
      'select * from public.user_devices where push_token = $1',
      [value],
    );
    return rows;
  }

  const errorOf = (reply: { json: <T>() => T }) =>
    reply.json<{ error: { code: string; details: Body } }>().error;

  describe('U1 register', () => {
    let user: UserFixture;

    beforeAll(async () => {
      user = await createUser(client);
    });

    it('creates the row and answers 200 {device_id}; the same installation keeps its id', async () => {
      const installation = randomUUID();
      const first = await registerDevice(app, user.id, installation, {
        platform: 'android',
        app_version: '1.0.0',
      });
      expect(first.statusCode).toBe(200);
      const { device_id: deviceId } = first.json<{ device_id: string }>();
      expect(Object.keys(first.json<Body>())).toEqual(['device_id', 'push_token_status']);
      expect(first.json<Body>().push_token_status).toBe('none');

      const [row] = (await rowsOf(user.id)).filter((r) => r.installation_id === installation);
      expect(row).toMatchObject({
        id: deviceId,
        platform: 'android',
        app_version: '1.0.0',
        push_provider: null,
        push_token: null,
        push_token_updated_at: null,
      });

      const again = await registerDevice(app, user.id, installation.toUpperCase(), {
        platform: 'ios',
        app_version: '1.1.0',
      });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ device_id: deviceId, push_token_status: 'none' });
      const [updated] = (await rowsOf(user.id)).filter((r) => r.installation_id === installation);
      expect(updated.platform).toBe('ios');
      expect(updated.app_version).toBe('1.1.0');
      expect(updated.created_at).toEqual(row.created_at);
      expect(updated.last_seen_at.getTime()).toBeGreaterThan(row.last_seen_at.getTime());
    });

    it('stores a token; left out keeps it; null clears it', async () => {
      const installation = randomUUID();
      const value = token();
      await registerDevice(app, user.id, installation, {
        platform: 'android',
        app_version: '1.0.0',
        push_provider: 'fcm',
        push_token: value,
      });
      let [row] = await rowWithToken(value);
      expect(row).toMatchObject({ installation_id: installation, push_provider: 'fcm' });
      expect(row.push_token_updated_at).not.toBeNull();
      const stamped = row.push_token_updated_at;

      await registerDevice(app, user.id, installation, {
        platform: 'android',
        app_version: '1.0.1',
      });
      [row] = await rowWithToken(value);
      expect(row.push_token_updated_at).toEqual(stamped);
      expect(row.app_version).toBe('1.0.1');

      await registerDevice(app, user.id, installation, {
        platform: 'android',
        app_version: '1.0.1',
        push_token: null,
      });
      expect(await rowWithToken(value)).toEqual([]);
      const [cleared] = (await rowsOf(user.id)).filter((r) => r.installation_id === installation);
      expect(cleared.push_provider).toBeNull();
      expect(cleared.push_token_updated_at!.getTime()).toBeGreaterThan(stamped!.getTime());
    });

    it('a token is on one device only: registering it elsewhere (any user) clears it there', async () => {
      const other = await createUser(client);
      const value = token();
      const a = randomUUID();
      const b = randomUUID();
      const c = randomUUID();
      const body = {
        platform: 'ios',
        app_version: '3.0',
        push_provider: 'apns',
        push_token: value,
      };

      await registerDevice(app, user.id, a, body);
      await registerDevice(app, user.id, b, body);
      expect((await rowWithToken(value)).map((r) => r.installation_id)).toEqual([b]);

      // Another account signs in on the same phone: the token moves to that account.
      await registerDevice(app, other.id, c, { ...body, push_provider: 'fcm' });
      const [moved] = await rowWithToken(value);
      expect(moved).toMatchObject({ user_id: other.id, installation_id: c, push_provider: 'fcm' });
      const left = (await rowsOf(user.id)).filter((r) =>
        [a, b].some((id) => id === r.installation_id),
      );
      expect(left.map((r) => [r.push_token, r.push_provider])).toEqual([
        [null, null],
        [null, null],
      ]);
    });

    it(`${PARALLEL} parallel registrations of one token on different installations: one row keeps it`, async () => {
      const value = token('race');
      const users: UserFixture[] = [];
      for (let i = 0; i < 4; i++) users.push(await createUser(client));
      const replies = await Promise.all(
        Array.from({ length: PARALLEL }, (_, i) =>
          registerDevice(app, users[i % users.length].id, randomUUID(), {
            platform: 'android',
            app_version: '1',
            push_provider: 'fcm',
            push_token: value,
          }),
        ),
      );
      expect(replies.map((r) => r.statusCode)).toEqual(Array(PARALLEL).fill(200));
      expect(await rowWithToken(value)).toHaveLength(1);
    });

    it('two users may use the same installation id (one row each)', async () => {
      const other = await createUser(client);
      const installation = randomUUID();
      const one = await registerDevice(app, user.id, installation, {
        platform: 'ios',
        app_version: '1',
      });
      const two = await registerDevice(app, other.id, installation, {
        platform: 'ios',
        app_version: '1',
      });
      expect(one.json<Body>().device_id).not.toEqual(two.json<Body>().device_id);
    });
  });

  describe('push_token_status and the dead-token hash (D69, gap 49)', () => {
    /** A U1 body; `pushToken` undefined = no push fields, null = clear. */
    function android(pushToken?: string | null): Body {
      const body: Body = { platform: 'android', app_version: '2.0.0' };
      if (pushToken === null) return { ...body, push_provider: null, push_token: null };
      if (pushToken !== undefined) return { ...body, push_provider: 'fcm', push_token: pushToken };
      return body;
    }

    /** What the delivery worker does when the provider answers `unregistered` (same code path). */
    async function providerSaysUnregistered(deviceId: string, value: string): Promise<void> {
      await new DeliveriesRepository(
        app.get(DatabaseService),
        app.get(AuditService),
      ).clearPushToken(deviceId, value);
      tokensUsed.push(pushTokenHash(value));
    }

    async function deviceRow(deviceId: string): Promise<DeviceRow> {
      const { rows } = await client.query<DeviceRow>(
        'select * from public.user_devices where id = $1',
        [deviceId],
      );
      return rows[0];
    }

    const statusOf = (reply: { json: <T>() => T }) => reply.json<Body>().push_token_status;
    const idOf = (reply: { json: <T>() => T }) => reply.json<{ device_id: string }>().device_id;

    it('unregistered: the token is cleared and its SHA-256 kept in the same statement', async () => {
      const user = await createUser(client);
      const dead = token('dead');
      const reply = await registerDevice(app, user.id, randomUUID(), android(dead));
      expect(statusOf(reply)).toBe('ok');
      const deviceId = idOf(reply);

      await providerSaysUnregistered(deviceId, dead);
      const row = await deviceRow(deviceId);
      expect(row).toMatchObject({
        push_token: null,
        push_provider: null,
        push_token_invalid_hash: pushTokenHash(dead),
      });
      expect(row.push_token_invalid_hash).not.toContain(dead);
    });

    it('a token re-registered since is kept: no hash is written for the old one', async () => {
      const user = await createUser(client);
      const installation = randomUUID();
      const old = token('old');
      const current = token('current');
      const deviceId = idOf(await registerDevice(app, user.id, installation, android(old)));
      await registerDevice(app, user.id, installation, android(current));
      await providerSaysUnregistered(deviceId, old);
      expect(await deviceRow(deviceId)).toMatchObject({
        push_token: current,
        push_token_invalid_hash: null,
      });
    });

    it('U1 with the dead token -> invalid, nothing stored; a new token -> ok, stored, hash cleared', async () => {
      const user = await createUser(client);
      const installation = randomUUID();
      const dead = token('dead');
      const deviceId = idOf(await registerDevice(app, user.id, installation, android(dead)));
      await providerSaysUnregistered(deviceId, dead);
      const cleared = await deviceRow(deviceId);

      const refused = await registerDevice(app, user.id, installation, {
        ...android(dead),
        app_version: '2.0.1',
      });
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toEqual({ device_id: deviceId, push_token_status: 'invalid' });
      expect(await deviceRow(deviceId)).toMatchObject({
        push_token: null,
        push_provider: null,
        push_token_invalid_hash: pushTokenHash(dead),
        push_token_updated_at: cleared.push_token_updated_at,
        app_version: '2.0.1',
      });
      expect(await rowWithToken(dead)).toEqual([]);
      // Refused again on the next try (the app still has the cached token).
      expect(statusOf(await registerDevice(app, user.id, installation, android(dead)))).toBe(
        'invalid',
      );

      const fresh = token('fresh');
      const renewed = await registerDevice(app, user.id, installation, android(fresh));
      expect(renewed.json()).toEqual({ device_id: deviceId, push_token_status: 'ok' });
      expect(await deviceRow(deviceId)).toMatchObject({
        push_token: fresh,
        push_provider: 'fcm',
        push_token_invalid_hash: null,
      });
    });

    it('the dead hash belongs to its device: another installation may register that token', async () => {
      const user = await createUser(client);
      const dead = token('dead');
      const deviceId = idOf(await registerDevice(app, user.id, randomUUID(), android(dead)));
      await providerSaysUnregistered(deviceId, dead);
      expect(statusOf(await registerDevice(app, user.id, randomUUID(), android(dead)))).toBe('ok');
      expect(await rowWithToken(dead)).toHaveLength(1);
    });

    it('no push fields: ok when a token is stored, none when not; the hash is kept', async () => {
      const user = await createUser(client);
      const withToken = randomUUID();
      await registerDevice(app, user.id, withToken, android(token()));
      expect(statusOf(await registerDevice(app, user.id, withToken, android()))).toBe('ok');
      expect(statusOf(await registerDevice(app, user.id, randomUUID(), android()))).toBe('none');

      const deadInstallation = randomUUID();
      const dead = token('dead');
      const deviceId = idOf(await registerDevice(app, user.id, deadInstallation, android(dead)));
      await providerSaysUnregistered(deviceId, dead);
      expect(statusOf(await registerDevice(app, user.id, deadInstallation, android()))).toBe(
        'none',
      );
      expect((await deviceRow(deviceId)).push_token_invalid_hash).toBe(pushTokenHash(dead));
    });

    it('null push fields clear the token: none', async () => {
      const user = await createUser(client);
      const installation = randomUUID();
      await registerDevice(app, user.id, installation, android(token()));
      expect(statusOf(await registerDevice(app, user.id, installation, android(null)))).toBe(
        'none',
      );
    });
  });

  describe('U2 clear push token', () => {
    it('clears only the caller’s installation; 204 also when there is nothing to clear', async () => {
      const user = await createUser(client);
      const other = await createUser(client);
      const installation = randomUUID();
      const mine = token();
      const second = token();
      const theirs = token();
      await registerDevice(app, user.id, installation, {
        platform: 'android',
        app_version: '1',
        push_provider: 'fcm',
        push_token: mine,
      });
      const otherInstallation = randomUUID();
      await registerDevice(app, user.id, otherInstallation, {
        platform: 'android',
        app_version: '1',
        push_provider: 'fcm',
        push_token: second,
      });
      // Same installation id under another account.
      await registerDevice(app, other.id, installation, {
        platform: 'android',
        app_version: '1',
        push_provider: 'fcm',
        push_token: theirs,
      });

      const reply = await clearDevicePushToken(app, user.id, installation);
      expect(reply.statusCode).toBe(204);
      expect(reply.body).toBe('');
      expect(await rowWithToken(mine)).toEqual([]);
      expect(await rowWithToken(second)).toHaveLength(1);
      expect(await rowWithToken(theirs)).toHaveLength(1);
      const [row] = (await rowsOf(user.id)).filter((r) => r.installation_id === installation);
      expect(row).toMatchObject({ push_token: null, push_provider: null, platform: 'android' });

      expect((await clearDevicePushToken(app, user.id, installation)).statusCode).toBe(204);
      expect((await clearDevicePushToken(app, user.id, randomUUID())).statusCode).toBe(204);
    });
  });

  describe('errors', () => {
    it('no token → 401 user_devices:not_authenticated (both routes)', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/v1/me/devices/current',
        headers: { 'x-atlas-installation-id': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify({ platform: 'ios', app_version: '1' }),
      });
      expect(put.statusCode).toBe(401);
      expect(errorOf(put).code).toBe('user_devices:not_authenticated');
      const del = await app.inject({
        method: 'DELETE',
        url: '/v1/me/devices/current/push-token',
        headers: { 'x-atlas-installation-id': randomUUID() },
      });
      expect(del.statusCode).toBe(401);
      expect(errorOf(del).code).toBe('user_devices:not_authenticated');
    });

    it('a valid Supabase token whose user does not exist → 401 user_devices:not_authenticated', async () => {
      const reply = await registerDevice(app, randomUUID(), randomUUID(), {
        platform: 'ios',
        app_version: '1',
      });
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('user_devices:not_authenticated');
    });

    it('header is checked before the body; missing or malformed → 422 invalid_installation_id', async () => {
      const user = await createUser(client);
      for (const header of [undefined, 'abc', `${randomUUID()}x`]) {
        const put = await registerDevice(app, user.id, header, { platform: 'x' });
        expect(put.statusCode).toBe(422);
        expect(errorOf(put)).toMatchObject({
          code: 'user_devices:invalid_installation_id',
          details: { field: 'x-atlas-installation-id' },
        });
        const del = await clearDevicePushToken(app, user.id, header);
        expect(del.statusCode).toBe(422);
        expect(errorOf(del).code).toBe('user_devices:invalid_installation_id');
      }
      expect(await rowsOf(user.id)).toEqual([]);
    });

    it('body codes in field order, 422 with details.field, nothing stored', async () => {
      const user = await createUser(client);
      const cases: [unknown, string, string][] = [
        ['text', 'validation:invalid_request', 'body'],
        [{ platform: 'web', app_version: '1' }, 'user_devices:invalid_platform', 'platform'],
        [{ platform: 'ios' }, 'user_devices:invalid_app_version', 'app_version'],
        [
          { platform: 'ios', app_version: '1', push_provider: 'x', push_token: 'a' },
          'user_devices:invalid_push_provider',
          'push_provider',
        ],
        [
          { platform: 'ios', app_version: '1', push_provider: 'apns', push_token: 'a b' },
          'user_devices:invalid_push_token',
          'push_token',
        ],
      ];
      for (const [body, code, field] of cases) {
        const reply = await registerDevice(app, user.id, randomUUID(), body);
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply)).toMatchObject({ code, details: { field } });
      }
      expect(await rowsOf(user.id)).toEqual([]);
    });
  });

  describe('push tokens never reach logs, error bodies or the audit log (AC5)', () => {
    it('a failing database write answers 500 internal:error without the token anywhere', async () => {
      const user = await createUser(client);
      const value = token('secret');
      // A Drizzle query error carries the statement's parameters (the token) in its message.
      jest.spyOn(DevicesRepository.prototype, 'register').mockRejectedValueOnce(
        Object.assign(new Error(`Failed query: insert ... params: ${value}`), {
          cause: Object.assign(new Error(`duplicate key (push_token)=(${value})`), {
            code: '23505',
          }),
        }),
      );
      const reply = await registerDevice(app, user.id, randomUUID(), {
        platform: 'android',
        app_version: '1',
        push_provider: 'fcm',
        push_token: value,
      });
      expect(reply.statusCode).toBe(500);
      expect(errorOf(reply).code).toBe('internal:error');
      expect(reply.body).not.toContain(value);
      expect(logs.text).not.toContain(value);
    });

    it('no token used in this file appears in any log line, error body or audit row', async () => {
      const user = await createUser(client);
      const value = token('logs');
      const bad = `${value} with space`;
      const rejected = await registerDevice(app, user.id, randomUUID(), {
        platform: 'android',
        app_version: '1',
        push_provider: 'fcm',
        push_token: bad,
      });
      expect(rejected.body).not.toContain(value);
      await registerDevice(app, user.id, randomUUID(), {
        platform: 'android',
        app_version: '1',
        push_provider: 'fcm',
        push_token: value,
      });
      for (const used of tokensUsed) expect(logs.text).not.toContain(used);
      const { rows } = await client.query<{ text: string }>(
        `select coalesce(string_agg(row_to_json(a)::text, ''), '') as text from public.audit_log a`,
      );
      for (const used of tokensUsed) expect(rows[0].text).not.toContain(used);
    });
  });

  it('works with a Supabase access token (AC4): the device belongs to the token’s `sub`', async () => {
    const user = await createUser(client);
    const reply = await app.inject({
      method: 'PUT',
      url: '/v1/me/devices/current',
      headers: {
        ...(await authHeader(user.id)),
        'x-atlas-installation-id': randomUUID(),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ platform: 'ios', app_version: '1' }),
    });
    expect(reply.statusCode).toBe(200);
    expect((await rowsOf(user.id)).map((r) => r.id)).toEqual([reply.json<Body>().device_id]);
  });
});
