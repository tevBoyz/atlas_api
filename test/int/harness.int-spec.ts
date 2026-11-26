import { Redis } from 'ioredis';
import type { Client } from 'pg';

import { LOCAL_DEFAULT_DATABASE_URL } from '../../src/db/tooling/database-url';
import { openTestClient, openTestTransaction, type TestTransaction } from '../support/database';
import {
  addActiveMember,
  createCircle,
  createIncident,
  createUser,
  inviteMember,
} from '../support/fixtures';
import { workerDatabaseName, workerId } from '../support/stack';

/**
 * The test harness itself (API-100-13 AC1, AC2): each worker owns a database and a Redis index on
 * containers with random ports, and the fixture builders satisfy the real constraints and triggers.
 */
describe('Test harness (API-100-13)', () => {
  describe('AC1: isolation', () => {
    let client: Client;
    let redis: Redis;

    beforeAll(async () => {
      client = await openTestClient();
      redis = new Redis(process.env.REDIS_URL!);
    });

    afterAll(async () => {
      await client.end();
      redis.disconnect();
    });

    it('uses the database of this worker, as the API role, with every migration applied', async () => {
      const { rows } = await client.query<{ db: string; role: string; migrations: number }>(
        `select current_database() as db, current_user as role,
                (select count(*)::int from public.api_schema_migrations) as migrations`,
      );
      expect(rows[0].db).toBe(workerDatabaseName());
      expect(rows[0].role).toBe('postgres');
      expect(rows[0].migrations).toBeGreaterThanOrEqual(2);
    });

    it('uses the Redis index of this worker', () => {
      expect(new URL(process.env.REDIS_URL!).pathname).toBe(`/${workerId()}`);
    });

    it('never uses the compose stack or its ports', () => {
      expect(new URL(process.env.DATABASE_URL!).port).not.toBe(
        new URL(LOCAL_DEFAULT_DATABASE_URL).port,
      );
      expect(new URL(process.env.REDIS_URL!).port).not.toBe('63799');
    });
  });

  describe('AC2: fixture builders', () => {
    let t: TestTransaction;

    beforeAll(async () => {
      t = await openTestTransaction();
    });

    afterAll(async () => {
      await t.rollback();
    });

    it('user: a public.users account (confirmed phone) and a complete profile', async () => {
      const user = await createUser(t.client, { phone: true });
      const { rows } = await t.client.query<{
        phone: string;
        confirmed: boolean;
        complete: boolean;
      }>(
        `select u.phone, u.phone_confirmed_at is not null as confirmed,
                p.profile_setup_completed_at is not null as complete
           from public.users u join public.profiles p on p.id = u.id where u.id = $1`,
        [user.id],
      );
      expect(rows).toEqual([{ phone: user.phone, confirmed: true, complete: true }]);
    });

    it('user without a profile', async () => {
      const user = await createUser(t.client, { profile: false });
      const { rows } = await t.client.query('select 1 from public.profiles where id = $1', [
        user.id,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('circle: owner row is active and stamped by the trigger', async () => {
      const owner = await createUser(t.client);
      const circle = await createCircle(t.client, owner);
      const { rows } = await t.client.query<{ role: string; status: string; stamped: boolean }>(
        `select role, status, activated_at is not null as stamped
           from public.safety_circle_members where id = $1`,
        [circle.ownerMemberId],
      );
      expect(rows).toEqual([{ role: 'owner', status: 'active', stamped: true }]);
    });

    it('invited member stays pending; accepted member is active with activated_at', async () => {
      const owner = await createUser(t.client);
      const circle = await createCircle(t.client, owner);
      const invited = await inviteMember(t.client, circle);
      const accepted = await addActiveMember(t.client, circle, await createUser(t.client));
      const { rows } = await t.client.query<{ id: string; status: string; stamped: boolean }>(
        `select id, status, activated_at is not null as stamped
           from public.safety_circle_members where id = any($1::uuid[])`,
        [[invited.id, accepted.id]],
      );
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: invited.id, status: 'pending', stamped: false },
          { id: accepted.id, status: 'active', stamped: true },
        ]),
      );
    });

    it('incident: active and resolved rows', async () => {
      const resident = await createUser(t.client);
      const circle = await createCircle(t.client, resident);
      const resolved = await createIncident(t.client, resident, circle, { status: 'resolved' });
      const active = await createIncident(t.client, resident, circle);
      const { rows } = await t.client.query<{ id: string; status: string }>(
        'select id, status from public.incidents where resident_id = $1',
        [resident.id],
      );
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: resolved.id, status: 'resolved' },
          { id: active.id, status: 'active' },
        ]),
      );
    });
  });
});
