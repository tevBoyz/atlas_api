import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { PROFILE_COLUMNS } from '../../src/modules/profiles/profiles.repository';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { errorOf, sqlAs } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createUser } from '../support/fixtures';
import { createAuthUser, getProfile, profileViaRls } from '../support/profile-api';

/**
 * API-100-34: `GET /v1/me/profile` (spec §11.3 P1) against the app's direct `profiles` SELECT
 * (`fetchOwn`, spec §7.8) and `_avatars_public_url`.
 *
 * - AC1: every §4.2 column, in the table's column order and with the same JSON values as PostgREST's
 *   `select *` (compared with `row_to_json` of the row through RLS, as the app reads it), plus
 *   `avatar_url`; 404 `profiles:profile_not_found` without a row; 401 `profiles:not_authenticated`.
 * - AC2: only the caller's own row (the statement is limited by `profile.self`; there is no id to
 *   name another row). `test/int/profile-exposure.int-spec.ts` checks every route of the API.
 * - AC3: p99 well under the client's 15 s cap (< 500 ms locally).
 */
type Body = Record<string, unknown>;

const SUPABASE_URL = 'https://example-project.supabase.co';
const HOST = 'example-project.supabase.co';

describe('GET /v1/me/profile (API-100-34)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ SUPABASE_URL, RATE_LIMIT_AUTHENTICATED_MAX: '1000000' }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  it('AC1: no token → 401 profiles:not_authenticated', async () => {
    const reply = await getProfile(app, null);
    expect(reply.statusCode).toBe(401);
    expect(errorOf(reply).code).toBe('profiles:not_authenticated');
  });

  it('AC1: no profile row → 404 profiles:profile_not_found', async () => {
    const id = randomUUID();
    await createAuthUser(client, id);
    const reply = await getProfile(app, id);
    expect(reply.statusCode).toBe(404);
    expect(errorOf(reply).code).toBe('profiles:profile_not_found');
  });

  it('AC1: the column list is the live table, in column order', async () => {
    const { rows } = await client.query<{ name: string }>(
      `select attname as name from pg_attribute
        where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped
        order by attnum`,
    );
    expect(rows.map((r) => r.name)).toEqual([...PROFILE_COLUMNS]);
  });

  it('AC1: the body is the app’s select * (same keys, order, values and text) plus avatar_url', async () => {
    const user = await createUser(client, { fullName: '  Spaced Name ' });
    await client.query(
      `update public.profiles
          set avatar_path = $2, gender = 'male', emergency_notes = 'Note', allergies = 'Dust',
              share_blood_type = true, personal_info_completed_at = '2026-11-20 10:00:00+00'
        where id = $1`,
      [user.id, `${user.id}/avatar.jpg`],
    );
    const reply = await getProfile(app, user.id);
    expect(reply.statusCode).toBe(200);
    const viaRls = await profileViaRls(client, user.id);
    const body = reply.json<Body>();
    expect(Object.keys(body)).toEqual([...PROFILE_COLUMNS, 'avatar_url']);
    const { avatar_url: avatarUrl, ...columns } = body;
    expect(JSON.stringify(columns)).toBe(viaRls);
    expect(body.personal_info_completed_at).toBe('2026-11-20T10:00:00+00:00');
    expect(body.date_of_birth).toBe('1990-01-15');
    // Same URL as `_avatars_public_url` behind PostgREST (Host = the project's host), and as the
    // app's `getPublicUrl` (`{SUPABASE_URL}/storage/v1/object/public/avatars/{path}`).
    expect(avatarUrl).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/avatars/${user.id}/avatar.jpg`,
    );
    const fromSql = await sqlAs<string>(
      client,
      user.id,
      'public._avatars_public_url($1)',
      [`${user.id}/avatar.jpg`],
      { host: HOST },
    );
    expect(avatarUrl).toBe(fromSql);
  });

  it('AC1: avatar_url is null without a photo, also for a blank path', async () => {
    const user = await createUser(client);
    expect((await getProfile(app, user.id)).json<Body>().avatar_url).toBeNull();
    await client.query(`update public.profiles set avatar_path = '   ' where id = $1`, [user.id]);
    expect((await getProfile(app, user.id)).json<Body>().avatar_url).toBeNull();
  });

  it('AC2: each caller gets their own row only', async () => {
    const a = await createUser(client, { fullName: 'Reader A' });
    const b = await createUser(client, { fullName: 'Reader B' });
    expect((await getProfile(app, a.id)).json<Body>()).toMatchObject({
      id: a.id,
      full_name: 'Reader A',
    });
    expect((await getProfile(app, b.id)).json<Body>()).toMatchObject({
      id: b.id,
      full_name: 'Reader B',
    });
  });

  it('AC2: query parameters cannot name another profile', async () => {
    const a = await createUser(client, { fullName: 'Asker' });
    const b = await createUser(client, { fullName: 'Other' });
    const reply = await app.inject({
      method: 'GET',
      url: `/v1/me/profile?id=${b.id}&user_id=${b.id}`,
      headers: await authHeader(a.id),
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json<Body>().id).toBe(a.id);
  });

  it('AC3: p99 of 200 reads is under 500 ms', async () => {
    const user = await createUser(client);
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      const reply = await getProfile(app, user.id);
      times.push(performance.now() - started);
      expect(reply.statusCode).toBe(200);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.ceil(0.99 * times.length) - 1]).toBeLessThan(500);
  });
});
