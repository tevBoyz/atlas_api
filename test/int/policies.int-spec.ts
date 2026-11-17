import { randomUUID } from 'node:crypto';

import { and, inArray, sql } from 'drizzle-orm';

import { DomainError } from '../../src/common/errors';
import {
  circleActiveMember,
  circleActiveMemberSince,
  circleOwner,
  deliveryOwn,
  incidentCountsView,
  incidentEventsView,
  incidentMemberView,
  type IncidentPolicy,
  incidentResident,
  inviteRecipient,
  membershipActivate,
  profileSelf,
  requireIncident,
} from '../../src/common/policies';
import { incidents } from '../../src/db/schema';
import { openTestTransaction, type TestTransaction } from './support/database';

/**
 * Authorization policies against the LOCAL Postgres (API-100-09 AC2-AC5). Reproduces the access
 * expectations of db/baseline/tests/membership_access_window.sql (rule 54) at the policy level,
 * plus the microsecond window boundary, circles A/B isolation and the other §11.4 rules.
 *
 * All fixtures live in one transaction that is rolled back (seed data untouched). Inside one
 * transaction `now()` never moves, so every timestamp is explicit (microsecond precision).
 */

/** "Now" of the SQL test: the moment the late member joins. */
const T = '2026-11-10 12:00:00.000000+00';
const T_MINUS_1US = '2026-11-10 11:59:59.999999+00';
const T_PLUS_1US = '2026-11-10 12:00:00.000001+00';
const ago = (interval: string) => sql`(${T}::timestamptz - ${interval}::interval)`;
const after = (interval: string) => sql`(${T}::timestamptz + ${interval}::interval)`;

const id = () => randomUUID();
const users = {
  resident: id(),
  early: id(), // joined 2 days before T
  member: id(), // joins at T (the SQL test's late member)
  removed: id(), // active at T, later removed by the owner
  joiner: id(), // joins while incident B is ongoing (T + 1 min)
  pending: id(), // claimed pending invite
  declined: id(), // declined invite
  outsider: id(),
  otherOwner: id(), // owns circle 2
};
const circle1 = id();
const circle2 = id();
const rows = {
  owner: id(),
  early: id(),
  member: id(),
  removed: id(),
  joiner: id(),
  pending: id(),
  declined: id(),
  owner2: id(),
  phoneInvite: id(),
  linkInvite: id(),
};
const inc = {
  /** Resolved, activated 1 day before T (before the member joined). */
  a: id(),
  /** Active, activated exactly at T (same instant as the member's activation). */
  b: id(),
  /** Resolved, activated 1 microsecond before the member's activation. */
  b2: id(),
  /** Cancelled (legacy), after T: members never see it. */
  cancelled: id(),
  /** Resolved without a circle. */
  noCircle: id(),
  /** Circle 2, active. */
  z: id(),
};
const delivery = { early: id(), member: id(), removed: id(), joinerStray: id() };

async function insertFixtures(t: TestTransaction): Promise<void> {
  const q = (text: string, values: unknown[] = []) => t.client.query(text, values);

  const phones: Record<string, string | null> = {
    resident: '12015550190',
    member: '12015550191',
    pending: '12015550192',
    outsider: '12015550193',
  };
  for (const [name, userId] of Object.entries(users)) {
    await q(
      `insert into auth.users (instance_id, id, aud, role, email, phone, email_confirmed_at,
                               created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
               $2, $3, now(), now(), now())`,
      [userId, `policy-${name}-${userId.slice(0, 8)}@example.test`, phones[name] ?? null],
    );
    await q(
      `insert into public.profiles (id, full_name, date_of_birth, profile_setup_completed_at)
       values ($1, $2, date '1990-01-01', now())`,
      [userId, `Policy ${name}`],
    );
  }

  await t.db.execute(sql`
    insert into public.safety_circles (id, owner_id, name, created_at)
    values (${circle1}, ${users.resident}, 'My Safety Circle', ${ago('10 days')}),
           (${circle2}, ${users.otherOwner}, 'My Safety Circle', ${ago('10 days')})`);

  // activated_at is passed explicitly: allowed for this (maintenance) role, exactly like the SQL
  // test's backfill-style insert. The API itself never writes it (membership.activate).
  const member = (
    rowId: string,
    circleId: string,
    role: string,
    status: string,
    userId: string | null,
    activatedAt: ReturnType<typeof sql> | null,
    extra: { phone?: string; token?: string } = {},
  ) =>
    t.db.execute(sql`
      insert into public.safety_circle_members (
        id, circle_id, role, status, display_name, user_id, phone,
        invite_token, invite_expires_at, activated_at)
      values (${rowId}, ${circleId}, ${role}, ${status}, 'Policy member', ${userId},
              ${extra.phone ?? null}, ${extra.token ?? null},
              ${extra.token ? after('7 days') : null}, ${activatedAt})`);

  const token = () => (randomUUID() + randomUUID()).replace(/-/g, '');
  await member(rows.owner, circle1, 'owner', 'active', users.resident, ago('10 days'));
  await member(rows.early, circle1, 'member', 'active', users.early, ago('2 days'));
  await member(rows.member, circle1, 'member', 'active', users.member, sql`${T}::timestamptz`);
  await member(rows.removed, circle1, 'member', 'active', users.removed, sql`${T}::timestamptz`);
  await member(rows.joiner, circle1, 'member', 'active', users.joiner, after('1 minute'));
  await member(rows.pending, circle1, 'member', 'pending', users.pending, null, { token: token() });
  await member(rows.declined, circle1, 'member', 'declined', users.declined, null);
  await member(rows.owner2, circle2, 'owner', 'active', users.otherOwner, ago('10 days'));
  // Invites for invite.recipient: an unclaimed phone invite and an unclaimed link invite.
  await member(rows.phoneInvite, circle2, 'member', 'pending', null, null, {
    phone: '+12015550191',
    token: token(),
  });
  await member(rows.linkInvite, circle2, 'member', 'pending', null, null, { token: token() });

  const incident = (
    incidentId: string,
    residentId: string,
    circleId: string | null,
    status: string,
    activatedAt: ReturnType<typeof sql>,
  ) => {
    const resolved = status === 'resolved';
    return t.db.execute(sql`
      insert into public.incidents (id, resident_id, circle_id, status, activated_at, sent_at,
                                    emergency_type, resolved_at, resolved_reason)
      values (${incidentId}, ${residentId}, ${circleId}, ${status}, ${activatedAt},
              ${activatedAt}, 'medical', ${resolved ? after('3 days') : null},
              ${resolved ? 'safe' : null})`);
  };
  await incident(inc.a, users.resident, circle1, 'resolved', ago('1 day'));
  await incident(inc.b, users.resident, circle1, 'active', sql`${T}::timestamptz`);
  await incident(inc.b2, users.resident, circle1, 'resolved', sql`${T_MINUS_1US}::timestamptz`);
  await incident(inc.cancelled, users.resident, circle1, 'cancelled', after('1 day'));
  await incident(inc.noCircle, users.resident, null, 'resolved', after('2 days'));
  await incident(inc.z, users.otherOwner, circle2, 'active', after('1 hour'));

  // Deliveries for B (early, member, removed) and a stray row for the joiner (SQL test).
  for (const [deliveryId, rowId, userId] of [
    [delivery.early, rows.early, users.early],
    [delivery.member, rows.member, users.member],
    [delivery.removed, rows.removed, users.removed],
    [delivery.joinerStray, rows.joiner, users.joiner],
  ]) {
    await q(
      `insert into public.incident_deliveries (id, incident_id, member_id, member_user_id)
       values ($1, $2, $3, $4)`,
      [deliveryId, inc.b, rowId, userId],
    );
  }
}

describe('Authorization policies against local Postgres (API-100-09)', () => {
  let t: TestTransaction;

  beforeAll(async () => {
    t = await openTestTransaction();
    await insertFixtures(t);
  });

  afterAll(async () => {
    await t?.rollback();
  });

  // Each test in its own savepoint: a failing statement cannot abort the shared transaction.
  beforeEach(async () => {
    await t.client.query('savepoint each_test');
  });

  afterEach(async () => {
    await t.client.query('rollback to savepoint each_test');
  });

  const byId = (policy: IncidentPolicy, incidentId: string, callerId: string) =>
    policy.checkById(t.db, incidentId, callerId);

  /** Incidents of the fixture set a caller may see through a policy (list / SQL predicate form). */
  async function listed(policy: IncidentPolicy, callerId: string): Promise<string[]> {
    const found = await t.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(inArray(incidents.id, Object.values(inc)), policy.where({ callerId })));
    return found.map((r) => r.id).sort();
  }

  describe('circle.activeMemberSince (AC2: window boundary, nulls)', () => {
    const since = (callerId: string, at: string | null, circleId: string | null = circle1) =>
      circleActiveMemberSince.check(t.db, { circleId, callerId, at });

    it('member activated exactly at the incident activated_at → allowed', async () => {
      expect(await since(users.member, T)).toBe(true);
    });

    it('member activated 1 microsecond after the incident → denied', async () => {
      expect(await since(users.member, T_MINUS_1US)).toBe(false);
      expect(await byId(incidentMemberView, inc.b2, users.member)).toBe(false);
    });

    it('later instants stay allowed', async () => {
      expect(await since(users.member, T_PLUS_1US)).toBe(true);
    });

    it('false when any argument is null', async () => {
      expect(await since(users.member, null)).toBe(false);
      expect(await since(users.member, T, null)).toBe(false);
      expect(
        await circleActiveMemberSince.check(t.db, { circleId: circle1, callerId: null, at: T }),
      ).toBe(false);
    });

    it('pending and declined rows never pass, whatever the instant', async () => {
      expect(await since(users.pending, '2099-01-01 00:00:00+00')).toBe(false);
      expect(await since(users.declined, '2099-01-01 00:00:00+00')).toBe(false);
    });
  });

  describe('membership_access_window.sql expectations (rule 54)', () => {
    it('resident sees own incidents through incident.resident regardless of the window', async () => {
      for (const incidentId of Object.values(inc).filter((i) => i !== inc.z)) {
        expect(await byId(incidentResident, incidentId, users.resident)).toBe(true);
      }
      expect(await listed(incidentResident, users.resident)).toEqual(
        [inc.a, inc.b, inc.b2, inc.cancelled, inc.noCircle].sort(),
      );
    });

    it('the resident never gets their own incident through incident.memberView', async () => {
      expect(await listed(incidentMemberView, users.resident)).toEqual([]);
    });

    it('resident sees events and counts of own incidents (any status)', async () => {
      expect(await byId(incidentEventsView, inc.a, users.resident)).toBe(true);
      expect(await byId(incidentEventsView, inc.cancelled, users.resident)).toBe(true);
      expect(await byId(incidentCountsView, inc.a, users.resident)).toBe(true);
      expect(await byId(incidentCountsView, inc.noCircle, users.resident)).toBe(true);
    });

    it('early member (joined before both) sees A and B', async () => {
      expect(await listed(incidentMemberView, users.early)).toEqual([inc.a, inc.b, inc.b2].sort());
    });

    it('member who joined after A: B only (list, details, events)', async () => {
      expect(await listed(incidentMemberView, users.member)).toEqual([inc.b]);
      expect(await byId(incidentMemberView, inc.a, users.member)).toBe(false);
      expect(await byId(incidentMemberView, inc.b, users.member)).toBe(true);
      expect(await byId(incidentEventsView, inc.a, users.member)).toBe(false);
      expect(await byId(incidentEventsView, inc.b, users.member)).toBe(true);
    });

    it('member: counts on active B; own delivery row only', async () => {
      expect(await byId(incidentCountsView, inc.b, users.member)).toBe(true);
      expect(await deliveryOwn.checkById(t.db, delivery.member, users.member)).toBe(true);
      expect(await deliveryOwn.checkById(t.db, delivery.early, users.member)).toBe(false);
    });

    it('counts need status active for members (resolved A is not counted for early)', async () => {
      expect(await byId(incidentCountsView, inc.a, users.early)).toBe(false);
      expect(await byId(incidentCountsView, inc.b, users.early)).toBe(true);
    });

    it('joiner (added while B is ongoing) sees nothing; a stray delivery row opens nothing', async () => {
      expect(await listed(incidentMemberView, users.joiner)).toEqual([]);
      expect(await byId(incidentEventsView, inc.b, users.joiner)).toBe(false);
      expect(await byId(incidentCountsView, inc.b, users.joiner)).toBe(false);
      expect(await deliveryOwn.checkById(t.db, delivery.joinerStray, users.joiner)).toBe(false);
    });

    it.each(['pending', 'declined', 'outsider'] as const)('%s user sees nothing', async (who) => {
      const callerId = users[who];
      for (const policy of [incidentMemberView, incidentEventsView, incidentCountsView]) {
        expect(await listed(policy, callerId)).toEqual([]);
      }
    });

    it('activating/cancelled incidents and incidents without a circle are invisible to members', async () => {
      expect(await byId(incidentMemberView, inc.cancelled, users.early)).toBe(false);
      expect(await byId(incidentEventsView, inc.cancelled, users.early)).toBe(false);
      expect(await byId(incidentMemberView, inc.noCircle, users.early)).toBe(false);
    });

    it('removed member: sees B before removal, nothing after (row deleted)', async () => {
      expect(await byId(incidentMemberView, inc.b, users.removed)).toBe(true);
      await t.scoped(async () => {
        await t.client.query('delete from public.safety_circle_members where id = $1', [
          rows.removed,
        ]);
        expect(await listed(incidentMemberView, users.removed)).toEqual([]);
        expect(await listed(incidentEventsView, users.removed)).toEqual([]);
        expect(await deliveryOwn.checkById(t.db, delivery.removed, users.removed)).toBe(false);
      });
    });

    it('left member: nothing after leaving (row deleted, delivery cascades)', async () => {
      await t.scoped(async () => {
        await t.client.query('delete from public.safety_circle_members where id = $1', [
          rows.member,
        ]);
        expect(await listed(incidentMemberView, users.member)).toEqual([]);
        expect(await listed(incidentEventsView, users.member)).toEqual([]);
        expect(await byId(incidentCountsView, inc.b, users.member)).toBe(false);
        expect(await deliveryOwn.checkById(t.db, delivery.member, users.member)).toBe(false);
      });
    });

    it('a person who rejoins gets a new activated_at: earlier incidents stay hidden', async () => {
      await t.scoped(async () => {
        await t.db.execute(sql`
          update public.safety_circle_members
             set status = 'active', activated_at = ${after('2 hours')}
           where id = ${rows.removed}`);
        expect(await byId(incidentMemberView, inc.b, users.removed)).toBe(false);
      });
    });
  });

  describe('parity with the SQL helpers for every caller × incident', () => {
    it('matches _is_active_circle_member_since, _can_view_incident_events, RLS and delivery counts rules', async () => {
      let compared = 0;
      for (const callerId of Object.values(users)) {
        // _can_view_incident_events reads auth.uid() from the request claims (transaction-local).
        await t.db.execute(
          sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: callerId, role: 'authenticated' })}, true)`,
        );
        const result = await t.db.execute<{
          id: string;
          since: boolean;
          events: boolean;
          member_rls: boolean;
          counts: boolean;
          member_circle: boolean;
        }>(sql`
          select i.id,
                 coalesce(public._is_active_circle_member_since(i.circle_id, ${callerId}::uuid, i.activated_at), false) as since,
                 public._can_view_incident_events(i.id) as events,
                 (i.circle_id is not null and i.status in ('active', 'resolved')
                  and public._is_active_circle_member_since(i.circle_id, ${callerId}::uuid, i.activated_at)
                  and i.resident_id <> ${callerId}::uuid) as member_rls,
                 (i.resident_id = ${callerId}::uuid
                  or (i.circle_id is not null and i.status = 'active'
                      and public._is_active_circle_member_since(i.circle_id, ${callerId}::uuid, i.activated_at))) as counts,
                 coalesce(public._is_active_circle_member(i.circle_id, ${callerId}::uuid), false) as member_circle,
                 i.circle_id, i.activated_at::text as activated_at
            from public.incidents i
           where i.id in (${sql.join(
             Object.values(inc).map((v) => sql`${v}::uuid`),
             sql`, `,
           )})`);
        for (const row of result.rows as unknown as Array<Record<string, unknown>>) {
          const incidentId = row.id as string;
          expect({
            incidentId,
            callerId,
            since: await circleActiveMemberSince.check(t.db, {
              circleId: row.circle_id as string | null,
              callerId,
              at: row.activated_at as string,
            }),
            events: await byId(incidentEventsView, incidentId, callerId),
            member_rls: await byId(incidentMemberView, incidentId, callerId),
            counts: await byId(incidentCountsView, incidentId, callerId),
            member_circle: await circleActiveMember.check(t.db, {
              circleId: row.circle_id as string | null,
              callerId,
            }),
          }).toEqual({
            incidentId,
            callerId,
            since: row.since,
            events: row.events,
            member_rls: row.member_rls === true,
            counts: row.counts === true,
            member_circle: row.member_circle,
          });
          compared += 1;
        }
      }
      expect(compared).toBe(Object.keys(users).length * Object.keys(inc).length);
    });
  });

  describe('circles (AC5: circle A member gets nothing from circle B)', () => {
    it('active member of circle 1 gets nothing from circle 2', async () => {
      expect(await byId(incidentMemberView, inc.z, users.member)).toBe(false);
      expect(await byId(incidentEventsView, inc.z, users.member)).toBe(false);
      expect(
        await circleActiveMember.check(t.db, { circleId: circle2, callerId: users.member }),
      ).toBe(false);
    });

    it('circle.activeMember: active rows (owner included) only', async () => {
      const member = (callerId: string) =>
        circleActiveMember.check(t.db, { circleId: circle1, callerId });
      expect(await member(users.resident)).toBe(true);
      expect(await member(users.member)).toBe(true);
      expect(await member(users.joiner)).toBe(true); // circle reads are not windowed
      expect(await member(users.pending)).toBe(false);
      expect(await member(users.declined)).toBe(false);
      expect(await member(users.outsider)).toBe(false);
    });

    it('circle.owner', async () => {
      expect(await circleOwner.check(t.db, { circleId: circle1, callerId: users.resident })).toBe(
        true,
      );
      expect(await circleOwner.check(t.db, { circleId: circle1, callerId: users.member })).toBe(
        false,
      );
      expect(await circleOwner.check(t.db, { circleId: circle2, callerId: users.resident })).toBe(
        false,
      );
    });
  });

  describe('hidden existence (AC4)', () => {
    it('a failed incident policy raises the operation not_found code (404)', async () => {
      const failure = requireIncident(
        t.db,
        incidentMemberView,
        inc.a,
        users.member,
        'get_incident_details',
      );
      await expect(failure).rejects.toBeInstanceOf(DomainError);
      await expect(failure).rejects.toMatchObject({
        code: 'get_incident_details:not_found',
        status: 404,
      });
    });

    it('an unknown incident gives the same error as a hidden one', async () => {
      await expect(
        requireIncident(t.db, incidentCountsView, id(), users.member, 'incident_delivery_counts'),
      ).rejects.toMatchObject({ code: 'incident_delivery_counts:not_found' });
    });

    it('passes when the policy allows', async () => {
      await expect(
        requireIncident(t.db, incidentMemberView, inc.b, users.member, 'get_incident_details'),
      ).resolves.toBeUndefined();
    });
  });

  describe('profile.self, invite.recipient, membership.activate', () => {
    it('profile.self', async () => {
      expect(
        await profileSelf.check(t.db, { profileId: users.member, callerId: users.member }),
      ).toBe(true);
      expect(
        await profileSelf.check(t.db, { profileId: users.member, callerId: users.early }),
      ).toBe(false);
      expect(await profileSelf.check(t.db, { profileId: null, callerId: users.early })).toBe(false);
    });

    it('invite.recipient: phone invite needs the caller Auth phone (normalized)', async () => {
      // Auth stores 12015550191 (no "+"); the invite row has +12015550191.
      expect(await inviteRecipient.checkById(t.db, rows.phoneInvite, users.member)).toBe(true);
      expect(await inviteRecipient.checkById(t.db, rows.phoneInvite, users.outsider)).toBe(false);
      expect(await inviteRecipient.checkById(t.db, rows.phoneInvite, users.early)).toBe(false); // no phone
    });

    it('invite.recipient: link invite → any token holder; claimed row → only that user', async () => {
      expect(await inviteRecipient.checkById(t.db, rows.linkInvite, users.outsider)).toBe(true);
      expect(await inviteRecipient.checkById(t.db, rows.pending, users.pending)).toBe(true);
      expect(await inviteRecipient.checkById(t.db, rows.pending, users.outsider)).toBe(false);
    });

    it('invite.recipient: explicit Auth phone operand', async () => {
      expect(
        await inviteRecipient.check(t.db, {
          callerId: users.outsider,
          member: { userId: sql`null::uuid`, phone: sql`'+12015550191'::text` },
          authPhone: ' 12015550191 ',
        }),
      ).toBe(true);
    });

    it('membership.activate: accept activates member rows; setup only the caller owner row', async () => {
      const activate = (memberId: string, path: string, callerId: string) =>
        membershipActivate.checkById(t.db, memberId, { path, callerId });
      expect(await activate(rows.pending, 'invite_accept', users.pending)).toBe(true);
      expect(await activate(rows.owner, 'invite_accept', users.resident)).toBe(false);
      expect(await activate(rows.owner, 'profile_setup_owner_row', users.resident)).toBe(true);
      expect(await activate(rows.owner, 'profile_setup_owner_row', users.member)).toBe(false);
      expect(await activate(rows.pending, 'profile_setup_owner_row', users.resident)).toBe(false);
      expect(await activate(rows.pending, 'owner_direct_update', users.resident)).toBe(false);
    });
  });
});
