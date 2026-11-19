import type { Client } from 'pg';

import { openTestClient } from '../support/database';

/**
 * `0004_client_incidents_backend_switch.sql`: the rollback switch the mobile app reads
 * (docs/phase1_handoff.md section 5). The row exists after migrations with the default
 * `"supabase"`; a signed-in user (`authenticated`) can read it but not change it.
 */
const KEY = 'client_incidents_backend';

describe('app_config client_incidents_backend (migration 0004)', () => {
  let client: Client;

  beforeAll(async () => {
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
  });

  /** Runs `fn` as the `authenticated` role inside a transaction that is always rolled back. */
  const asAuthenticated = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      return await fn();
    } finally {
      await client.query('rollback');
    }
  };

  it('is recorded as applied and the row holds the default "supabase"', async () => {
    const applied = await client.query(
      `select 1 from public.api_schema_migrations where id = '0004_client_incidents_backend_switch'`,
    );
    expect(applied.rowCount).toBe(1);
    const { rows } = await client.query<{ value: unknown; type: string }>(
      'select value, jsonb_typeof(value) as type from public.app_config where key = $1',
      [KEY],
    );
    expect(rows).toEqual([{ value: 'supabase', type: 'string' }]);
  });

  it('authenticated can read it', async () => {
    const rows = await asAuthenticated(
      async () =>
        (
          await client.query<{ value: unknown }>(
            'select value from public.app_config where key = $1',
            [KEY],
          )
        ).rows,
    );
    expect(rows).toEqual([{ value: 'supabase' }]);
  });

  it.each([
    ['update', `update public.app_config set value = '"api"'::jsonb where key = '${KEY}'`],
    ['delete', `delete from public.app_config where key = '${KEY}'`],
    [
      'insert',
      `insert into public.app_config (key, value) values ('${KEY}_probe', '"api"'::jsonb)`,
    ],
  ])('authenticated cannot %s it (42501)', async (_name, sql) => {
    await expect(asAuthenticated(() => client.query(sql))).rejects.toMatchObject({
      code: '42501',
    });
    const { rows } = await client.query<{ value: unknown }>(
      'select value from public.app_config where key = $1',
      [KEY],
    );
    expect(rows).toEqual([{ value: 'supabase' }]);
  });
});
