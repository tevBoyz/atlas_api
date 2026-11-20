import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import { aliasColumn, deliveryOwn } from '../../src/common/policies';
import { createTestApp } from '../../src/testing/test-app';
import {
  acceptInvite,
  createInviteLink,
  declineInvite,
  leaveCircle,
  removeMember,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  acknowledgeIncident,
  getDeliveryCounts,
  getIncidentDetails,
  getIncidentEvents,
  listRecentIncidents,
  listResponderIncidents,
  markSafe,
  submitAlert,
} from '../support/incident-api';

/**
 * Parity coverage of db/baseline/tests/membership_access_window.sql (API-100-13 AC5; rule 54). One
 * entry per SQL assertion: the name quotes the SQL message, prefixed with its line in the file.
 *
 * `beforeAll` walks the script's scenario in its order. Incident writes go through the API (submit,
 * mark safe); the removal and the leave too (`DELETE /v1/circles/{circle_id}/members/{member_id}` and
 * `POST /v1/circles/{circle_id}/leave`, API-100-32, replacing the script's `remove_circle_member` /
 * `leave_safety_circle`; L396 and L426 also check they answered 200). The script's fixture rows
 * (the owner row, the backdated early member, the joiner) stay raw writes as the migration role, as
 * the script does them. At each step it records what the API answers for that caller:
 * delivery counts and acknowledge (API-100-20), the responder list and details (API-100-21) and the
 * event log (API-100-22). The RLS reads of the script ("sees % incidents", "sees % events", "own
 * delivery rows") are checked twice: against the database roles, as the SQL does (the app still reads
 * through Supabase until cutover), and through the API rule that replaces them
 * (`GET /v1/incidents/{id}`, `GET /v1/incidents/{id}/events`, delivery counts, and the `delivery.own`
 * policy).
 *
 * The two pending invites (`Member Window`, `Pending Window`) are created through the API's link
 * invite (`POST /v1/me/circle/invites/link`, API-100-27) by the resident, who owns the circle; L121
 * checks that the API's pending row has no `activated_at`.
 *
 * The member joins through the API's accept (`POST /v1/invites/{token}/accept`, API-100-30) of the
 * `Member Window` link (the script writes the same row change by hand); L148 checks that the
 * trigger stamped the transaction's `now()` (= `invite_consumed_at` of the same write). At the end
 * the pending user declines the `Pending Window` link through the API (`decline`, API-100-30;
 * the script sets `declined` by hand) and L456 checks it has no `activated_at`.
 *
 * Still `it.todo`, with the story that completes them: L84 (owner row) with API-100-36, L189 (no
 * client-chosen activated_at; `membership.activate`) with the Phase 2 gate API-100-33. Nothing of
 * the membership parts still goes through the SQL functions.
 *
 * The window case for closure recipients (rule 54 in `_incident_active_recipient_ids`, used by
 * `mark_incident_safe`; the script closes incident A at L131 but has no assertion of its own) is
 * covered by API-100-19 in test/int/incidents-mark-safe.int-spec.ts, "rule 54 closure recipients".
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof getDeliveryCounts>>;

interface Seen {
  incidents: number;
  /** `GET /v1/incidents/{id}` status per incident (incident.memberView), when the step reads it. */
  details?: Record<string, number>;
  /** Events through RLS (`incident_events_select_visible`). */
  rlsEvents?: number;
  /** `GET /v1/incidents/{id}/events` per incident: status and event count (incident.eventsView). */
  apiEvents?: Record<string, { status: number; count: number }>;
  deliveries?: number;
  deliveriesByPolicy?: number;
}

describe('membership_access_window.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;

  let resident: UserFixture;
  let early: UserFixture;
  let member: UserFixture;
  let removed: UserFixture;
  let joiner: UserFixture;
  let pendingUser: UserFixture;
  let outsider: UserFixture;
  let aId: string;
  let bId: string;

  let deliveriesToB: number;
  let residentSeen: Seen;
  let residentCountsA: Reply;
  let residentCountsB: Reply;
  let residentRecent: Body[];
  let earlySeen: Seen;
  let memberSeesA: Seen;
  let memberSeesB: Seen;
  let memberCountsB: Reply;
  let memberAckB: Reply;
  let memberOwnRows: Seen;
  let joinerSeen: Seen;
  let joinerOwnRows: Seen;
  let joinerCountsB: Reply;
  let joinerAckB: Reply;
  let pendingSeen: Seen;
  let outsiderSeen: Seen;
  let removedBefore: Seen;
  let removedAfter: Seen;
  let removeStatus: number;
  let leaveStatus: number;
  let leftSeen: Seen;
  let leftAckB: Reply;
  let memberList: string[];
  let memberDetailsA: Reply;
  let memberDetailsB: Reply;
  let joinerList: string[];
  let joinerDetailsB: Reply;
  let outsiderList: string[];
  let outsiderDetailsB: Reply;
  let removedList: string[];
  let removedDetailsB: Reply;
  let leftList: string[];
  let residentEventsA: Seen;
  let memberEventsA: Seen;
  let memberEventsB: Seen;
  let joinerEvents: Seen;
  let outsiderEvents: Seen;
  let removedEvents: Seen;
  let leftEvents: Seen;
  let pendingActivatedAt: string | null;
  let acceptStatus: number;
  let activation: { stamped_now: boolean; activated: boolean };
  let declineStatus: number;
  let declinedRow: { status: string; activated_at: string | null };

  /**
   * Runs `statement` (a `count(*)::int as n` query) as the `authenticated` role with `userId`'s JWT
   * claims, as the script's `set local role authenticated` block does. Always rolled back.
   */
  const rlsCount = async (userId: string, statement: string, params: unknown[]) => {
    await client.query('begin');
    try {
      await client.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
      );
      await client.query('set local role authenticated');
      const { rows } = await client.query<{ n: number }>(statement, params);
      return rows[0].n;
    } finally {
      await client.query('rollback');
    }
  };

  const rlsIncidents = (userId: string, ids: string[]) =>
    rlsCount(userId, 'select count(*)::int as n from public.incidents where id = any($1)', [ids]);

  /** What `userId` sees of `ids`: through RLS, and the API's details status for each. */
  const incidentsSeen = async (userId: string, ids: string[]): Promise<Seen> => {
    const details: Record<string, number> = {};
    for (const id of ids) {
      details[id === aId ? 'A' : 'B'] = (await getIncidentDetails(app, userId, id)).statusCode;
    }
    return { incidents: await rlsIncidents(userId, ids), details };
  };

  /** Events of `ids` that `userId` sees: through RLS, and through the API per incident. */
  const eventsSeen = async (userId: string, ids: string[]): Promise<Seen> => {
    const apiEvents: Record<string, { status: number; count: number }> = {};
    for (const id of ids) {
      const reply = await getIncidentEvents(app, userId, id);
      apiEvents[id === aId ? 'A' : 'B'] = {
        status: reply.statusCode,
        count: reply.statusCode === 200 ? reply.json<Body[]>().length : 0,
      };
    }
    const rlsEvents = await rlsCount(
      userId,
      'select count(*)::int as n from public.incident_events where incident_id = any($1)',
      [ids],
    );
    return { incidents: 0, rlsEvents, apiEvents };
  };

  const listOf = async (userId: string) =>
    (await listResponderIncidents(app, userId)).json<Body[]>().map((row) => row.id as string);

  /** Own delivery rows of A and B: through RLS, and through the API's `delivery.own` policy. */
  const ownDeliveries = async (userId: string): Promise<Seen> => {
    const deliveries = await rlsCount(
      userId,
      'select count(*)::int as n from public.incident_deliveries where member_user_id = $1',
      [userId],
    );
    const policy = deliveryOwn.where({
      callerId: userId,
      delivery: {
        incidentId: aliasColumn('d', 'incident_id'),
        memberUserId: aliasColumn('d', 'member_user_id'),
      },
    });
    const result = await drizzle(client).execute<{ n: number }>(
      sql`select count(*)::int as n from public.incident_deliveries d
           where d.incident_id in (${aId}::uuid, ${bId}::uuid) and ${policy}`,
    );
    return { incidents: 0, deliveries, deliveriesByPolicy: result.rows[0].n };
  };

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    resident = await createUser(client, { fullName: 'Resident Window' });
    early = await createUser(client, { fullName: 'Early Window' });
    member = await createUser(client, { fullName: 'Member Window' });
    removed = await createUser(client, { fullName: 'Removed Window' });
    joiner = await createUser(client, { fullName: 'Joiner Window' });
    pendingUser = await createUser(client, { fullName: 'Pending Window' });
    outsider = await createUser(client, { fullName: 'Outsider Window' });

    const circle = await createCircle(client, resident);
    // Trusted maintenance path may set a past activation (backfill-style), as the script does.
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                 invite_consumed_at, activated_at)
       values ($1, 'member', 'active', 'Early Window', $2, now() - interval '2 days',
               now() - interval '2 days')`,
      [circle.id, early.id],
    );
    const removedRow = await addActiveMember(client, circle, removed);
    // The two pending invites through the API (API-100-27), as the resident (circle owner).
    const memberInvite = await createInviteLink(app, resident.id, {
      display_name: 'Member Window',
    });
    const pendingInvite = await createInviteLink(app, resident.id, {
      display_name: 'Pending Window',
    });
    expect([memberInvite.statusCode, pendingInvite.statusCode]).toEqual([201, 201]);
    const memberRow = { id: memberInvite.json<Body>().member_id as string };
    const memberToken = memberInvite.json<Body>().invite_token as string;
    const pendingToken = pendingInvite.json<Body>().invite_token as string;
    const pendingRowId = pendingInvite.json<Body>().member_id as string;
    pendingActivatedAt = (
      await client.query<{ activated_at: string | null }>(
        'select activated_at from public.safety_circle_members where id = $1',
        [memberRow.id],
      )
    ).rows[0].activated_at;

    // Incident A: submitted, closed, and dated 1 day ago (before the member joins).
    aId = (await submitAlert(app, resident.id, 'medical')).json<Body>().id as string;
    expect((await markSafe(app, resident.id, aId)).statusCode).toBe(200);
    await client.query(
      `update public.incidents
          set activated_at = now() - interval '1 day', sent_at = now() - interval '1 day'
        where id = $1`,
      [aId],
    );

    // The member accepts now, through the API (API-100-30).
    acceptStatus = (await acceptInvite(app, member.id, memberToken)).statusCode;
    activation = (
      await client.query<{ stamped_now: boolean; activated: boolean }>(
        `select activated_at = invite_consumed_at as stamped_now,
                status = 'active' and activated_at is not null as activated
           from public.safety_circle_members where id = $1`,
        [memberRow.id],
      )
    ).rows[0];

    // Incident B: started after the member joined.
    bId = (await submitAlert(app, resident.id, 'fire')).json<Body>().id as string;
    deliveriesToB = (
      await client.query<{ n: number }>(
        'select count(*)::int as n from public.incident_deliveries where incident_id = $1',
        [bId],
      )
    ).rows[0].n;

    // Joiner added while B is ongoing (one minute later), with a stray delivery row.
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                 invite_consumed_at, activated_at)
       values ($1, 'member', 'active', 'Joiner Window', $2, now() + interval '1 minute',
               now() + interval '1 minute')`,
      [circle.id, joiner.id],
    );
    await client.query(
      `insert into public.incident_deliveries (incident_id, member_id, member_user_id)
       select $1, m.id, $2 from public.safety_circle_members m
        where m.circle_id = $3 and m.user_id = $2`,
      [bId, joiner.id, circle.id],
    );

    const both = [aId, bId];

    // Resident.
    residentSeen = { incidents: await rlsIncidents(resident.id, both) };
    residentCountsA = await getDeliveryCounts(app, resident.id, aId);
    residentCountsB = await getDeliveryCounts(app, resident.id, bId);
    residentRecent = (await listRecentIncidents(app, resident.id, 'limit=5')).json<Body[]>();
    residentEventsA = await eventsSeen(resident.id, [aId]);

    // Early member.
    earlySeen = await incidentsSeen(early.id, both);

    // Member who joined after A.
    memberSeesA = await incidentsSeen(member.id, [aId]);
    memberSeesB = await incidentsSeen(member.id, [bId]);
    memberList = await listOf(member.id);
    memberDetailsA = await getIncidentDetails(app, member.id, aId);
    memberDetailsB = await getIncidentDetails(app, member.id, bId);
    memberEventsA = await eventsSeen(member.id, [aId]);
    memberEventsB = await eventsSeen(member.id, [bId]);
    memberCountsB = await getDeliveryCounts(app, member.id, bId);
    memberAckB = await acknowledgeIncident(app, member.id, bId);
    memberOwnRows = await ownDeliveries(member.id);

    // Joiner.
    joinerSeen = await incidentsSeen(joiner.id, both);
    joinerList = await listOf(joiner.id);
    joinerEvents = await eventsSeen(joiner.id, both);
    joinerOwnRows = await ownDeliveries(joiner.id);
    joinerDetailsB = await getIncidentDetails(app, joiner.id, bId);
    joinerCountsB = await getDeliveryCounts(app, joiner.id, bId);
    joinerAckB = await acknowledgeIncident(app, joiner.id, bId);

    // Pending user and outsider.
    pendingSeen = await incidentsSeen(pendingUser.id, both);
    outsiderSeen = await incidentsSeen(outsider.id, both);
    outsiderList = await listOf(outsider.id);
    outsiderDetailsB = await getIncidentDetails(app, outsider.id, bId);
    outsiderEvents = await eventsSeen(outsider.id, both);

    // Removed member: sees B before removal, nothing after.
    removedBefore = await incidentsSeen(removed.id, [bId]);
    removeStatus = (await removeMember(app, resident.id, circle.id, removedRow.id)).statusCode;
    removedAfter = await incidentsSeen(removed.id, both);
    removedList = await listOf(removed.id);
    removedDetailsB = await getIncidentDetails(app, removed.id, bId);
    removedEvents = await eventsSeen(removed.id, both);

    // Member leaves: nothing after.
    leaveStatus = (await leaveCircle(app, member.id, circle.id)).statusCode;
    leftSeen = await incidentsSeen(member.id, both);
    leftList = await listOf(member.id);
    leftEvents = await eventsSeen(member.id, both);
    leftAckB = await acknowledgeIncident(app, member.id, bId);

    // Declined rows carry no activation time: the pending user declines (API-100-30).
    declineStatus = (await declineInvite(app, pendingUser.id, pendingToken)).statusCode;
    declinedRow = (
      await client.query<{ status: string; activated_at: string | null }>(
        'select status, activated_at from public.safety_circle_members where id = $1',
        [pendingRowId],
      )
    ).rows[0];
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const codeOf = (reply: Reply) => reply.json<{ error: { code: string } }>().error.code;

  const policyQual = async () =>
    (
      await client.query<{ qual: string }>(
        `select pg_get_expr(p.polqual, p.polrelid) as qual
           from pg_policy p
          where p.polrelid = 'public.incidents'::regclass
            and p.polname = 'incidents_select_active_member'`,
      )
    ).rows[0].qual;

  it('L44: incidents_select_active_member does not use _is_active_circle_member_since', async () => {
    expect(await policyQual()).toMatch(/_is_active_circle_member_since/i);
  });

  it('L52: incidents_select_active_member has a raw members subquery (RLS recursion)', async () => {
    expect(await policyQual()).not.toMatch(/safety_circle_members/i);
  });

  it.todo('L84: owner row has no activated_at');
  it('L121: pending row has activated_at', () => {
    expect(pendingActivatedAt).toBeNull();
  });
  it('L148: activation did not stamp now(): %', () => {
    expect(acceptStatus).toBe(200);
    expect(activation).toEqual({ stamped_now: true, activated: true });
  });

  it('L159: B should deliver to early, member, removed: %', () => {
    expect(deliveriesToB).toBe(3);
  });

  it.todo('L189: owner backdated activated_at: %');

  it('L195: resident sees % own incidents', () => {
    expect(residentSeen.incidents).toBe(2);
    // incident.resident: the resident reads both, whatever their status or circle.
    expect(residentCountsA.statusCode).toBe(200);
    expect(residentCountsB.statusCode).toBe(200);
  });

  it('L202: resident recent list has % of own incidents', () => {
    expect(residentRecent.filter((row) => [aId, bId].includes(row.id as string))).toHaveLength(2);
  });

  it('L207: resident sees no events on A', () => {
    expect(residentEventsA.rlsEvents).toBeGreaterThan(0);
    // incident.eventsView: the resident reads the closed, backdated A (6 events).
    expect(residentEventsA.apiEvents).toEqual({ A: { status: 200, count: 6 } });
  });

  it('L217: early member sees % incidents', () => {
    expect(earlySeen.incidents).toBe(2);
    expect(earlySeen.details).toEqual({ A: 200, B: 200 });
  });

  it('L227: late member sees pre-join incident A via RLS', () => {
    expect(memberSeesA.incidents).toBe(0);
    expect(memberSeesA.details).toEqual({ A: 404 });
  });

  it('L232: member cannot see post-join incident B via RLS', () => {
    expect(memberSeesB.incidents).toBe(1);
    expect(memberSeesB.details).toEqual({ B: 200 });
  });

  it('L237: list_responder_incidents leaks A: %', () => {
    expect(memberList).not.toContain(aId);
  });

  it('L240: list_responder_incidents misses B: %', () => {
    expect(memberList).toContain(bId);
  });

  it('L245: details leak A: %', () => {
    expect(memberDetailsA.statusCode).toBe(404);
  });

  it('L249: details A got %', () => {
    expect(codeOf(memberDetailsA)).toBe('get_incident_details:not_found');
  });

  it('L255: details B wrong: %', () => {
    expect(memberDetailsB.statusCode).toBe(200);
    expect(memberDetailsB.json<Body>().id).toBe(bId);
  });
  it('L260: late member sees % events on A', () => {
    expect(memberEventsA.rlsEvents).toBe(0);
    expect(memberEventsA.apiEvents).toEqual({ A: { status: 404, count: 0 } });
  });

  it('L265: member sees no events on B', () => {
    expect(memberEventsB.rlsEvents).toBeGreaterThan(0);
    expect(memberEventsB.apiEvents?.B.status).toBe(200);
    expect(memberEventsB.apiEvents?.B.count).toBe(memberEventsB.rlsEvents);
  });

  it('L270: counts B wrong: %', () => {
    expect(memberCountsB.statusCode).toBe(200);
    expect(memberCountsB.json<Body>().delivered_count).toBeGreaterThanOrEqual(3);
  });

  it('L275: ack B wrong: %', () => {
    expect(memberAckB.statusCode).toBe(200);
    expect(memberAckB.json<Body>().acknowledged_count).toBe(1);
  });

  it('L280: member sees % own delivery rows', () => {
    expect(memberOwnRows.deliveries).toBe(1);
    expect(memberOwnRows.deliveriesByPolicy).toBe(1);
  });

  it('L290: joiner sees % incidents', () => {
    expect(joinerSeen.incidents).toBe(0);
    expect(joinerSeen.details).toEqual({ A: 404, B: 404 });
  });

  it('L294: joiner list not empty', () => {
    expect(joinerList).toEqual([]);
  });
  it('L299: joiner sees % events', () => {
    expect(joinerEvents.rlsEvents).toBe(0);
    expect(joinerEvents.apiEvents).toEqual({
      A: { status: 404, count: 0 },
      B: { status: 404, count: 0 },
    });
  });

  it('L304: joiner sees own stray delivery row', () => {
    expect(joinerOwnRows.deliveries).toBe(0);
    expect(joinerOwnRows.deliveriesByPolicy).toBe(0);
  });

  it('L309: details leak B to joiner: %', () => {
    expect(joinerDetailsB.statusCode).toBe(404);
  });

  it('L313: joiner details B got %', () => {
    expect(codeOf(joinerDetailsB)).toBe('get_incident_details:not_found');
  });

  it('L319: counts leak B to joiner: %', () => {
    expect(joinerCountsB.statusCode).toBe(404);
  });

  it('L323: joiner counts B got %', () => {
    expect(codeOf(joinerCountsB)).toBe('incident_delivery_counts:not_found');
  });

  it('L329: joiner acked B: %', () => {
    expect(joinerAckB.statusCode).toBe(404);
  });

  it('L333: joiner ack B got %', () => {
    expect(codeOf(joinerAckB)).toBe('acknowledge_incident:not_found');
  });

  it('L344: pending user sees % incidents', () => {
    expect(pendingSeen.incidents).toBe(0);
    expect(pendingSeen.details).toEqual({ A: 404, B: 404 });
  });

  it('L353: outsider sees % incidents', () => {
    expect(outsiderSeen.incidents).toBe(0);
    expect(outsiderSeen.details).toEqual({ A: 404, B: 404 });
  });

  it('L358: outsider sees % events', () => {
    expect(outsiderEvents.rlsEvents).toBe(0);
    expect(outsiderEvents.apiEvents).toEqual({
      A: { status: 404, count: 0 },
      B: { status: 404, count: 0 },
    });
  });
  it('L362: outsider list not empty', () => {
    expect(outsiderList).toEqual([]);
  });

  it('L367: details leak B to outsider: %', () => {
    expect(outsiderDetailsB.statusCode).toBe(404);
  });

  it('L371: outsider details B got %', () => {
    expect(codeOf(outsiderDetailsB)).toBe('get_incident_details:not_found');
  });

  it('L382: removed-to-be member cannot see B before removal', () => {
    expect(removedBefore.incidents).toBe(1);
    expect(removedBefore.details).toEqual({ B: 200 });
  });

  it('L396: removed member sees % incidents', () => {
    expect(removeStatus).toBe(200);
    expect(removedAfter.incidents).toBe(0);
    expect(removedAfter.details).toEqual({ A: 404, B: 404 });
  });

  it('L401: removed member sees % events', () => {
    expect(removedEvents.rlsEvents).toBe(0);
    expect(removedEvents.apiEvents).toEqual({
      A: { status: 404, count: 0 },
      B: { status: 404, count: 0 },
    });
  });
  it('L405: removed member list not empty', () => {
    expect(removedList).toEqual([]);
  });

  it('L410: details leak B to removed member: %', () => {
    expect(removedDetailsB.statusCode).toBe(404);
  });

  it('L414: removed details B got %', () => {
    expect(codeOf(removedDetailsB)).toBe('get_incident_details:not_found');
  });

  it('L426: left member sees % incidents', () => {
    expect(leaveStatus).toBe(200);
    expect(leftSeen.incidents).toBe(0);
    expect(leftSeen.details).toEqual({ A: 404, B: 404 });
  });

  it('L431: left member sees % events', () => {
    expect(leftEvents.rlsEvents).toBe(0);
    expect(leftEvents.apiEvents).toEqual({
      A: { status: 404, count: 0 },
      B: { status: 404, count: 0 },
    });
  });
  it('L435: left member list not empty', () => {
    expect(leftList).toEqual([]);
  });

  it('L440: left member acked B: %', () => {
    expect(leftAckB.statusCode).toBe(404);
  });

  it('L444: left member ack B got %', () => {
    expect(codeOf(leftAckB)).toBe('acknowledge_incident:not_found');
  });

  it('L456: declined row has activated_at', () => {
    expect(declineStatus).toBe(200);
    expect(declinedRow).toEqual({ status: 'declined', activated_at: null });
  });
});
