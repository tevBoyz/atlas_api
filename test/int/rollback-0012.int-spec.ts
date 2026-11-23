import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Client } from 'pg';

import { runMigrations } from '../../src/db/tooling/migrate';
import { openTestClient } from '../support/database';
import {
  avatarWritePolicies,
  realtimeMembersLeft,
  recloneWorkerDatabase,
  supabaseAccessSnapshot,
  supabasePrivilegesLeft,
} from '../support/retirement-state';
import { PRE_0012_TEMPLATE_DATABASE } from '../support/stack';

/**
 * Stage 7.6, API-100-62 DoD (D42): `db/rollback/0012_down.sql` restores EXACTLY what migration 0012
 * revoked, removed or dropped. On a clone of the database as it was before 0012 (baseline +
 * 0001-0011): snapshot (privileges of anon / authenticated / PUBLIC with grantor and grant option,
 * `supabase_realtime` members, every `storage.objects` policy), apply 0012 with the real runner,
 * check the production state, run the rollback, and compare: identical. Then 0012 applies again
 * cleanly, and a second rollback run refuses and changes nothing.
 */
const ROLLBACK_SQL = readFileSync(resolve('db/rollback/0012_down.sql'), 'utf8');
const silent = () => undefined;

describe('stage 7.6: db/rollback/0012_down.sql restores the pre-0012 state (D42)', () => {
  let client: Client;
  let before: string[];

  beforeAll(async () => {
    await recloneWorkerDatabase(PRE_0012_TEMPLATE_DATABASE);
    client = await openTestClient();
    before = await supabaseAccessSnapshot(client);
  }, 120_000);

  afterAll(async () => {
    await client.end();
  });

  it('the pre-0012 state is the surveyed one (grants, publication members, avatars policies)', () => {
    expect(before).toContain('migration 0012 recorded=false');
    expect(before).toContain('record table exists=false');
    expect(before).toContain('table public.profiles anon SELECT by postgres');
    expect(before).toContain('table public.app_config authenticated MAINTAIN by postgres');
    expect(before).toContain(
      'function public.submit_emergency_alert(text) authenticated EXECUTE by postgres',
    );
    expect(before).toContain(
      'function public.set_profiles_updated_at() PUBLIC EXECUTE by postgres',
    );
    expect(before.filter((l) => l.startsWith('table ') && l.includes(' anon '))).toHaveLength(24);
    expect(
      before.filter((l) => l.startsWith('table ') && l.includes(' authenticated ')),
    ).toHaveLength(30);
    expect(before.filter((l) => l.startsWith('function ') && l.includes(' anon '))).toHaveLength(8);
    expect(
      before.filter((l) => l.startsWith('function ') && l.includes(' authenticated ')),
    ).toHaveLength(40);
    expect(before.filter((l) => l.startsWith('function ') && l.includes(' PUBLIC '))).toHaveLength(
      5,
    );
    expect(before.filter((l) => l.startsWith('publication '))).toHaveLength(2);
    expect(before.filter((l) => l.startsWith('policy avatars_'))).toHaveLength(4);
  });

  it('0012 -> production state; rollback -> exactly the pre-0012 state; 0012 again; rollback twice refused', async () => {
    // The first run also applies the later migrations (0013, D44); they touch no Supabase access,
    // so the snapshot comparison below is unchanged, and they stay recorded through the rollback.
    expect(await runMigrations(client, resolve('db/migrations'), silent)).toEqual([
      '0012_retire_supabase_app_paths',
      '0013_membership_end_status',
    ]);
    expect(await supabasePrivilegesLeft(client)).toEqual([]);
    expect(await realtimeMembersLeft(client)).toEqual([]);
    expect(await avatarWritePolicies(client)).toEqual([]);

    await client.query(ROLLBACK_SQL);
    expect(await supabaseAccessSnapshot(client)).toEqual(before);

    // Re-runnable: 0012 applies again on the rolled-back database, and rolls back again.
    expect(await runMigrations(client, resolve('db/migrations'), silent)).toEqual([
      '0012_retire_supabase_app_paths',
    ]);
    expect(await supabasePrivilegesLeft(client)).toEqual([]);
    await client.query(ROLLBACK_SQL);
    expect(await supabaseAccessSnapshot(client)).toEqual(before);

    // A second rollback run stops at its check and changes nothing.
    await expect(client.query(ROLLBACK_SQL)).rejects.toThrow(/does not exist/);
    await client.query('rollback');
    expect(await supabaseAccessSnapshot(client)).toEqual(before);
  });
});
