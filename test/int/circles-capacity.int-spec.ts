import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Client } from 'pg';

import {
  holdsSlot,
  holdsSlotSql,
  inviteLookupStatus,
  inviteLookupStatusSql,
  memberAlias,
  shownMemberStatus,
  shownMemberStatusSql,
} from '../../src/modules/circles/invite-slots';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  errorOf,
  getCapacity,
  getOwnCircle,
  listMembers,
  ownCircleRow,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  fakeInviteToken,
  inviteMember,
  type UserFixture,
} from '../support/fixtures';

/**
 * `GET /v1/me/circle/capacity` (`circle_invite_capacity`) and `GET /v1/me/circle` (spec §11.3 C1),
 * API-100-24: what counts as a used slot (rule 8, every row state), the shared `holdsSlot` rule in
 * TypeScript and SQL against the capacity trigger's helper, the exact JSON text, no
 * `invite_token`, and one consistent snapshot while invites are created and expire.
 */
type Body = Record<string, unknown>;
type Member = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('own circle and capacity (API-100-24)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    // A high per-user limit: the race below reads far more often than the app's rhythm.
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000' }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  /** A pending row in any state, written as the migration role (the trigger still runs). */
  const insertPending = async (
    circle: CircleFixture,
    values: {
      name: string;
      expiresSql?: string;
      invitedSql?: string;
      canceled?: boolean;
      consumed?: boolean;
      status?: 'pending' | 'declined';
    },
  ): Promise<string> => {
    const id = randomUUID();
    await client.query(
      `insert into public.safety_circle_members (
         id, circle_id, role, status, display_name, invite_token, invited_at, invite_expires_at,
         invite_canceled_at, invite_consumed_at)
       values ($1, $2, 'member', $3, $4, $5, ${values.invitedSql ?? 'now()'},
               ${values.expiresSql ?? "now() + interval '7 days'"},
               case when $6::boolean then now() end, case when $7::boolean then now() end)`,
      [
        id,
        circle.id,
        values.status ?? 'pending',
        values.name,
        fakeInviteToken(),
        values.canceled ?? false,
        values.consumed ?? false,
      ],
    );
    return id;
  };

  describe('GET /v1/me/circle/capacity', () => {
    let owner: UserFixture;
    let circle: CircleFixture;

    beforeAll(async () => {
      owner = await createUser(client, { fullName: 'Capacity Owner' });
      circle = await createCircle(client, owner);
      // Owner row (excluded) + active 2 + valid pending 1 + expired 1 (invited 10 days ago) + expired
      // 1 second ago + declined 1. Used = 3. (A stored pending member row always has
      // invite_expires_at: constraint safety_circle_members_pending_invite_token; the null case of
      // the rule is covered by the row-state matrix below.)
      await addActiveMember(client, circle, await createUser(client, { fullName: 'Active One' }));
      await addActiveMember(client, circle, await createUser(client, { fullName: 'Active Two' }));
      await inviteMember(client, circle, { displayName: 'Valid Pending' });
      await insertPending(circle, {
        name: 'Expired Pending',
        invitedSql: "now() - interval '10 days'",
        expiresSql: "now() - interval '3 days'",
      });
      await insertPending(circle, {
        name: 'Just Expired',
        expiresSql: "now() - interval '1 second'",
      });
      await insertPending(circle, {
        name: 'Declined',
        status: 'declined',
        canceled: true,
        expiresSql: 'null',
      });
    });

    it('counts active + valid pending, owner excluded; exact JSON text', async () => {
      const reply = await getCapacity(app, owner.id);
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual({
        limit: 5,
        active_count: 2,
        pending_count: 1,
        used: 3,
        available: 2,
      });
      // Same keys in the same order and integer types: byte-equal JSON.
      expect(reply.body).toBe(
        '{"used":3,"limit":5,"available":2,"active_count":2,"pending_count":1}',
      );
    });

    it('a pending row that is canceled or consumed (not stored as declined/active) holds no slot', async () => {
      const canceled = await insertPending(circle, { name: 'Canceled Pending', canceled: true });
      const consumed = await insertPending(circle, { name: 'Consumed Pending', consumed: true });
      try {
        const body = (await getCapacity(app, owner.id)).json<Body>();
        expect(body).toMatchObject({ pending_count: 1, used: 3 });
      } finally {
        await client.query('delete from public.safety_circle_members where id = any($1)', [
          [canceled, consumed],
        ]);
      }
    });

    it('available never goes below 0 (rows past the trigger)', async () => {
      const fullOwner = await createUser(client, { fullName: 'Overfull Owner' });
      const full = await createCircle(client, fullOwner);
      await client.query(
        'alter table public.safety_circle_members disable trigger safety_circle_members_enforce_capacity',
      );
      try {
        for (let i = 0; i < 6; i += 1) {
          await inviteMember(client, full, { displayName: `Seat ${i}` });
        }
      } finally {
        await client.query(
          'alter table public.safety_circle_members enable trigger safety_circle_members_enforce_capacity',
        );
      }
      const reply = await getCapacity(app, fullOwner.id);
      expect(reply.json()).toEqual({
        limit: 5,
        active_count: 0,
        pending_count: 6,
        used: 6,
        available: 0,
      });
    });

    it('no location-sharing or setup check: an owner with sharing off still gets the capacity', async () => {
      await client.query(
        'update public.profiles set location_sharing_enabled = false where id = $1',
        [owner.id],
      );
      try {
        expect((await getCapacity(app, owner.id)).statusCode).toBe(200);
      } finally {
        await client.query(
          'update public.profiles set location_sharing_enabled = true where id = $1',
          [owner.id],
        );
      }
    });

    it('403 circle_invite_capacity:not_owner for a member, a user without a circle and one without a profile', async () => {
      const member = await createUser(client, { fullName: 'Only A Member' });
      await addActiveMember(client, circle, member);
      const loner = await createUser(client, { fullName: 'No Circle' });
      const bare = await createUser(client, { profile: false });
      for (const user of [member, loner, bare]) {
        const reply = await getCapacity(app, user.id);
        expect(reply.statusCode).toBe(403);
        expect(errorOf(reply).code).toBe('circle_invite_capacity:not_owner');
      }
    });

    it('401 circle_invite_capacity:not_authenticated without a token', async () => {
      const reply = await getCapacity(app, null);
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('circle_invite_capacity:not_authenticated');
    });
  });

  describe('GET /v1/me/circle', () => {
    it('no owned circle: {circle: null, members: [], capacity: null} (also for an active member elsewhere)', async () => {
      const someone = await createUser(client, { fullName: 'Circle Less' });
      const otherOwner = await createUser(client, { fullName: 'Other Owner' });
      await addActiveMember(client, await createCircle(client, otherOwner), someone);
      for (const user of [someone, await createUser(client, { profile: false })]) {
        const reply = await getOwnCircle(app, user.id);
        expect(reply.statusCode).toBe(200);
        expect(reply.body).toBe('{"circle":null,"members":[],"capacity":null}');
        expect(await ownCircleRow(client, user.id)).toBeNull();
      }
    });

    it('circle = the stored row, members = the owner view of the member list, capacity = the capacity read (same JSON text); no invite_token', async () => {
      const owner = await createUser(client, { fullName: 'Whole Circle Owner' });
      const circle = await createCircle(client, owner);
      const ben = await createUser(client, { fullName: 'Ben Active' });
      await addActiveMember(client, circle, ben);
      const pending = await inviteMember(client, circle, { displayName: 'Dan Pending' });
      await inviteMember(client, circle, { displayName: 'Old Expired', expiresInDays: -2 });

      const reply = await getOwnCircle(app, owner.id);
      expect(reply.statusCode).toBe(200);
      const body = reply.json<{ circle: Body; members: Member[]; capacity: Body }>();
      expect(Object.keys(body)).toEqual(['circle', 'members', 'capacity']);

      expect(JSON.stringify(body.circle)).toBe(
        JSON.stringify(await ownCircleRow(client, owner.id)),
      );
      expect(Object.keys(body.circle)).toEqual([
        'id',
        'owner_id',
        'name',
        'created_at',
        'updated_at',
      ]);
      expect(JSON.stringify(body.members)).toBe((await listMembers(app, owner.id, circle.id)).body);
      expect(JSON.stringify(body.capacity)).toBe((await getCapacity(app, owner.id)).body);
      expect(body.members.map((m) => [m.display_name, m.status])).toEqual([
        ['Whole Circle Owner', 'active'],
        ['Ben Active', 'active'],
        ['Dan Pending', 'pending'],
        ['Old Expired', 'expired'],
      ]);
      expect(body.capacity).toMatchObject({ active_count: 1, pending_count: 1, used: 2 });
      expect(reply.body).not.toContain('invite_token');
      expect(reply.body).not.toContain(pending.inviteToken);
    });

    it('401 safety_circles:not_authenticated without a token', async () => {
      const reply = await getOwnCircle(app, null);
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('safety_circles:not_authenticated');
    });
  });

  describe('holdsSlot / inviteLookupStatus: TypeScript = SQL form (= the capacity trigger helper for holdsSlot)', () => {
    // Every state that matters, relative to the database's now(); `+0` is "exactly now".
    const expiries = [
      'null',
      "now() - interval '1 day'",
      'now()',
      "now() + interval '1 microsecond'",
      "now() + interval '1 day'",
    ];
    const invitedAts = [
      'now()',
      "now() - interval '7 days'",
      "now() - interval '7 days' + interval '1 microsecond'",
      "now() - interval '8 days'",
    ];
    const cases: string[] = [];
    for (const role of ['member', 'owner']) {
      for (const status of ['pending', 'active', 'declined']) {
        for (const expires of expiries) {
          for (const invited of invitedAts) {
            for (const canceled of [false, true]) {
              for (const consumed of [false, true]) {
                cases.push(
                  `jsonb_build_object('id', gen_random_uuid(), 'circle_id', gen_random_uuid(),
                     'role', '${role}', 'status', '${status}', 'display_name', 'x',
                     'invited_at', ${invited}, 'created_at', now(), 'updated_at', now(),
                     'invite_expires_at', ${expires},
                     'invite_canceled_at', ${canceled ? 'now()' : 'null'},
                     'invite_consumed_at', ${consumed ? 'now()' : 'null'})`,
                );
              }
            }
          }
        }
      }
    }

    it(`agree on ${cases.length} row states`, async () => {
      const db = drizzle(client);
      const m = memberAlias('m');
      await client.query('begin');
      try {
        await client.query("select set_config('TimeZone', 'UTC', true)");
        const result = await db.execute<{
          now: string;
          role: string;
          status: string;
          invited_at: string;
          invite_expires_at: string | null;
          invite_canceled_at: string | null;
          invite_consumed_at: string | null;
          helper_holds: boolean;
          api_holds: boolean;
          api_lookup: string;
          api_shown: string;
        }>(sql`
          select now()::text as now,
                 m.role, m.status, m.invited_at::text, m.invite_expires_at::text,
                 m.invite_canceled_at::text, m.invite_consumed_at::text,
                 public._circle_invite_holds_slot(m) as helper_holds,
                 ${holdsSlotSql(m)} as api_holds,
                 ${inviteLookupStatusSql(m)} as api_lookup,
                 ${shownMemberStatusSql(m)} as api_shown
            from unnest(array[${sql.raw(cases.join(',\n'))}]) as c(j)
            cross join lateral jsonb_populate_record(null::public.safety_circle_members, c.j) m`);
        expect(result.rows).toHaveLength(cases.length);
        let holding = 0;
        for (const row of result.rows) {
          const slotRow = {
            role: row.role,
            status: row.status,
            invitedAt: row.invited_at,
            inviteExpiresAt: row.invite_expires_at,
            inviteCanceledAt: row.invite_canceled_at,
            inviteConsumedAt: row.invite_consumed_at,
          };
          expect(row.api_holds).toBe(row.helper_holds);
          expect(holdsSlot(slotRow, row.now)).toBe(row.helper_holds);
          expect(inviteLookupStatus(slotRow, row.now)).toBe(row.api_lookup);
          const sqlShown =
            row.status === 'pending' && row.api_lookup === 'expired' ? 'expired' : row.status;
          expect(row.api_shown).toBe(sqlShown);
          expect(shownMemberStatus(slotRow, row.now)).toBe(sqlShown);
          if (row.helper_holds) holding += 1;
        }
        // The matrix exercises both outcomes and the exact-now boundary.
        expect(holding).toBeGreaterThan(0);
        expect(holding).toBeLessThan(cases.length);
      } finally {
        await client.query('rollback');
      }
    });
  });

  describe('races: one snapshot while invites are created and expire', () => {
    it('members and capacity of GET /v1/me/circle always agree, and capacity never shows used > 5', async () => {
      const owner = await createUser(client, { fullName: 'Race Owner' });
      const circle = await createCircle(client, owner);
      await addActiveMember(client, circle, await createUser(client, { fullName: 'Race Active' }));
      const writer = await openTestClient();
      let stop = false;
      let writes = 0;
      // Writer: keeps up to 4 short-lived pending invites, each expiring 0-300 ms after it is written,
      // and deletes them again; every statement commits on its own.
      const writing = (async () => {
        const live: string[] = [];
        while (!stop) {
          if (live.length < 4) {
            const id = randomUUID();
            await writer.query(
              `insert into public.safety_circle_members (
                 id, circle_id, role, status, display_name, invite_token, invited_at,
                 invite_expires_at)
               values ($1, $2, 'member', 'pending', 'Racing Invite', $3, now(),
                       clock_timestamp() + make_interval(secs => $4))`,
              [id, circle.id, fakeInviteToken(), Math.random() * 0.3],
            );
            live.push(id);
          } else {
            await writer.query('delete from public.safety_circle_members where id = $1', [
              live.shift(),
            ]);
          }
          writes += 1;
          await sleep(5);
        }
      })();

      let sawPending = 0;
      let sawExpired = 0;
      try {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const [own, capacityReply] = await Promise.all([
            getOwnCircle(app, owner.id),
            getCapacity(app, owner.id),
          ]);
          expect(own.statusCode).toBe(200);
          const body = own.json<{ members: Member[]; capacity: Body }>();
          const members = body.members.filter((m) => m.role === 'member');
          const active = members.filter((m) => m.status === 'active').length;
          const pending = members.filter((m) => m.status === 'pending').length;
          sawPending += pending;
          sawExpired += members.filter((m) => m.status === 'expired').length;
          expect(body.capacity).toEqual({
            limit: 5,
            active_count: active,
            pending_count: pending,
            used: active + pending,
            available: 5 - active - pending,
          });
          const capacity = capacityReply.json<Body>();
          expect(capacity.used as number).toBeLessThanOrEqual(5);
          expect(capacity.used).toBe(
            (capacity.active_count as number) + (capacity.pending_count as number),
          );
        }
      } finally {
        stop = true;
        await writing;
        await writer.end();
      }
      // The race really happened: invites were seen both valid and expired.
      expect(writes).toBeGreaterThan(20);
      expect(sawPending).toBeGreaterThan(0);
      expect(sawExpired).toBeGreaterThan(0);
    });
  });
});
