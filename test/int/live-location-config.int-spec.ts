import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import { createUser } from '../support/fixtures';
import { callSqlAs, getLiveLocationConfig } from '../support/incident-api';

/**
 * `GET /v1/config/live-location` (API-100-17 AC1) against `get_live_location_config()` on the same
 * `app_config` values: what counts as "a number", the 12 / 45 fallbacks, and the values the SQL
 * function raises on. Each test restores the seeded values.
 */
type Body = Record<string, unknown>;

const INTERVAL = 'live_location_interval_seconds';
const STALE = 'live_location_stale_threshold_seconds';

describe('GET /v1/config/live-location (API-100-17)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let userId: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();
    userId = (await createUser(client)).id;
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  afterEach(async () => {
    await client.query(
      `insert into public.app_config (key, value) values ($1, '12'), ($2, '45')
       on conflict (key) do update set value = excluded.value`,
      [INTERVAL, STALE],
    );
  });

  /** Sets a key's raw jsonb text; null deletes the row. */
  const setValue = async (key: string, json: string | null) => {
    if (json === null) {
      await client.query('delete from public.app_config where key = $1', [key]);
      return;
    }
    await client.query(
      `insert into public.app_config (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [key, json],
    );
  };

  it('without a token: 401 get_live_location_config:not_authenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/config/live-location' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      'get_live_location_config:not_authenticated',
    );
  });

  it('seeded values: {"interval_seconds":12,"stale_threshold_seconds":45}, the SQL bytes', async () => {
    const res = await getLiveLocationConfig(app, userId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"interval_seconds":12,"stale_threshold_seconds":45}');
    const viaSql = await callSqlAs(client, userId, 'public.get_live_location_config()');
    expect(res.body).toBe(JSON.stringify(viaSql));
  });

  it('a user without a profile, and an unknown user id, get it too (any valid token)', async () => {
    for (const id of [(await createUser(client, { profile: false })).id, randomUUID()]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config/live-location',
        headers: await authHeader(id),
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it.each([
    ['30 and 90', '30', '90', 30, 90],
    ['missing rows', null, null, 12, 45],
    ['JSON strings', '"30"', '"90"', 12, 45],
    ['booleans', 'true', 'false', 12, 45],
    ['JSON null', 'null', 'null', 12, 45],
    ['objects and arrays', '{"v":30}', '[90]', 12, 45],
    ['zero', '0', '0', 12, 45],
    ['negatives', '-5', '-1', 12, 45],
    ['negative zero', '-0', '-0', 12, 45],
    ['an exponent that is an integer (1e2 is 100)', '1e2', '2.0e1', 100, 20],
    ['int4 max', '2147483647', '1', 2147483647, 1],
  ])('%s → same as the SQL function', async (_name, interval, stale, i, s) => {
    await setValue(INTERVAL, interval);
    await setValue(STALE, stale);
    const res = await getLiveLocationConfig(app, userId);
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toEqual({ interval_seconds: i, stale_threshold_seconds: s });
    const viaSql = await callSqlAs(client, userId, 'public.get_live_location_config()');
    expect(res.body).toBe(JSON.stringify(viaSql));
  });

  it.each([
    ['a decimal', '12.5', '22P02'],
    ['an integer written with a fraction', '12.0', '22P02'],
    ['out of int4 range', '2147483648', '22003'],
  ])(
    'SQL difference kept: %s makes the function raise; the API answers 500',
    async (_name, value, sqlState) => {
      await setValue(INTERVAL, value);
      await expect(
        callSqlAs(client, userId, 'public.get_live_location_config()'),
      ).rejects.toMatchObject({ code: sqlState });
      const res = await getLiveLocationConfig(app, userId);
      expect(res.statusCode).toBe(500);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('internal:error');
    },
  );

  it('reads nothing but app_config and writes nothing', async () => {
    const before = (
      await client.query('select key, value, updated_at from public.app_config order by key')
    ).rows;
    await getLiveLocationConfig(app, userId);
    const after = (
      await client.query('select key, value, updated_at from public.app_config order by key')
    ).rows;
    expect(after).toEqual(before);
  });
});
