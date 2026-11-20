import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import type { Client } from 'pg';

import { AuditService } from '../../src/modules/audit';
import {
  MEMBERSHIP_POST_COMMIT_HOOKS,
  type MembershipEndedEvent,
  type MembershipPostCommitHook,
} from '../../src/modules/circles/membership-post-commit';
import { ROOT_LOGGER } from '../../src/observability/logger';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import {
  errorOf,
  leaveCircle,
  listJoinedCircles,
  listMembers,
  removeMember,
  sqlRolledBack,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import {
  acknowledgeIncident,
  getDeliveryCounts,
  getIncidentDetails,
  getIncidentEvents,
  listResponderIncidents,
  markSafe,
  submitAlert,
} from '../support/incident-api';
import { compareWithSql, insertMember, memberRow } from '../support/invite-rows';

/**
 * API-100-32: `DELETE /v1/circles/{circle_id}/members/{member_id}` (`remove_circle_member`, spec
 * §11.3 C4) and `POST /v1/circles/{circle_id}/leave` (`leave_safety_circle`, C5) through
 * `MembershipService.end`: check order and codes (AC1/AC2), the hard delete with its cascading
 * deliveries, the audit rows and the post-commit revocation seam (AC3: after commit only, never on
 * rollback, a failing hook never fails the change), access ending at once for every incident read,
 * active and history (AC4, epic §18.1 P1), the locks (member row only, no circle lock), and the same
 * answers and row changes as the SQL functions (interchangeable).
 */
type Body = Record<string, unknown>;

const ENDED: MembershipEndedEvent[] = [];
let failHook = false;
const recordingHook: MembershipPostCommitHook = {
  afterMembershipEnded(event) {
    if (failHook) throw new Error('hook failed on purpose');
    ENDED.push(event);
  },
};
/** When set, the audit write of a membership end fails (forces a rollback after the delete). */
let failEndAudit = false;

describe('remove and leave (API-100-32)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;
  let holder: Client;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({}, (builder) =>
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
      })(builder)
        .overrideProvider(MEMBERSHIP_POST_COMMIT_HOOKS)
        .useValue([recordingHook])
        .overrideProvider(AuditService)
        .useFactory({
          factory: (logger: Logger) => {
            const real = new AuditService(logger);
            return {
              record: (entry: Parameters<AuditService['record']>[0], tx: never) =>
                failEndAudit && entry.action.startsWith('circle.member.')
                  ? Promise.reject(new Error('audit failed on purpose'))
                  : real.record(entry, tx),
            };
          },
          inject: [ROOT_LOGGER],
        }),
    ));
    client = await openTestClient();
    holder = await openTestClient();
  });

  afterAll(async () => {
    await holder?.end();
    await client?.end();
    await app?.close();
  });

  beforeEach(() => {
    ENDED.length = 0;
    failHook = false;
    failEndAudit = false;
  });

  interface Circle {
    owner: UserFixture;
    circle: CircleFixture;
    ben: UserFixture;
    benRow: MemberFixture;
    cara: UserFixture;
    caraRow: MemberFixture;
  }
  const circleWithMembers = async (): Promise<Circle> => {
    const owner = await createUser(client, { fullName: 'Owner Remove' });
    const circle = await createCircle(client, owner);
    const ben = await createUser(client, { fullName: 'Ben Member' });
    const cara = await createUser(client, { fullName: 'Cara Member' });
    const benRow = await addActiveMember(client, circle, ben);
    const caraRow = await addActiveMember(client, circle, cara);
    return { owner, circle, ben, benRow, cara, caraRow };
  };
  const expectCode = (reply: { statusCode: number }, status: number, code: string) => {
    expect({ status: reply.statusCode, code: errorOf(reply as never).code }).toEqual({
      status,
      code,
    });
  };
  const deliveries = async (memberId: string) =>
    (
      await client.query<{ n: number }>(
        'select count(*)::int as n from public.incident_deliveries where member_id = $1',
        [memberId],
      )
    ).rows[0].n;
  const auditOf = async (targetId: string) =>
    (
      await client.query<{ action: string; actor: string; target_type: string; detail: Body }>(
        `select action, actor_user_id::text as actor, target_type, detail
           from public.audit_log where target_id = $1 order by id`,
        [targetId],
      )
    ).rows;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  // --- authentication and path validation ----------------------------------------------------------

  it('without a token: 401 with each route’s code', async () => {
    const { circle, benRow } = await circleWithMembers();
    expectCode(
      await removeMember(app, null, circle.id, benRow.id),
      401,
      'remove_circle_member:not_authenticated',
    );
    expectCode(
      await leaveCircle(app, null, circle.id),
      401,
      'leave_safety_circle:not_authenticated',
    );
  });

  it('ids that are not uuid input: 422 validation:invalid_request on the field', async () => {
    const { owner, circle, benRow } = await circleWithMembers();
    const badCircle = await removeMember(app, owner.id, 'not-a-uuid', benRow.id);
    expectCode(badCircle, 422, 'validation:invalid_request');
    expect(errorOf(badCircle).details).toMatchObject({ field: 'circle_id' });
    const badMember = await removeMember(app, owner.id, circle.id, 'null');
    expectCode(badMember, 422, 'validation:invalid_request');
    expect(errorOf(badMember).details).toMatchObject({ field: 'member_id' });
    const badLeave = await leaveCircle(app, owner.id, 'null');
    expectCode(badLeave, 422, 'validation:invalid_request');
    expect(errorOf(badLeave).details).toMatchObject({ field: 'circle_id' });
    expect((await memberRow(client, benRow.id)).status).toBe('active');
  });

  // --- remove (AC1) --------------------------------------------------------------------------------

  it('remove: codes in the SQL order, nothing written on an error', async () => {
    const { owner, circle, ben, benRow, caraRow } = await circleWithMembers();
    const other = await circleWithMembers();
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expectCode(
      await removeMember(app, owner.id, circle.id, unknown),
      404,
      'remove_circle_member:not_found',
    );
    // A member row of another circle is not found under this circle (D15, 2026-11-20: the path's
    // circle must be the row's; stricter than the SQL), also for the owner of that other circle.
    expectCode(
      await removeMember(app, owner.id, circle.id, other.benRow.id),
      404,
      'remove_circle_member:not_found',
    );
    expectCode(
      await removeMember(app, other.owner.id, circle.id, other.benRow.id),
      404,
      'remove_circle_member:not_found',
    );
    // A member (not the owner) → 403, also for the owner row (ownership is checked first).
    expectCode(
      await removeMember(app, ben.id, circle.id, caraRow.id),
      403,
      'remove_circle_member:not_authorized',
    );
    expectCode(
      await removeMember(app, ben.id, circle.id, circle.ownerMemberId),
      403,
      'remove_circle_member:not_authorized',
    );
    expectCode(
      await removeMember(app, owner.id, circle.id, circle.ownerMemberId),
      409,
      'remove_circle_member:cannot_remove_owner',
    );
    for (const id of [benRow.id, caraRow.id, circle.ownerMemberId, other.benRow.id]) {
      expect(await memberRow(client, id)).toBeDefined();
    }
    expect(ENDED).toEqual([]);
  });

  it('remove: deletes an active row with its deliveries, audits, and announces after commit', async () => {
    const { owner, circle, ben, benRow, caraRow } = await circleWithMembers();
    const incident = (await submitAlert(app, owner.id, 'medical')).json<Body>();
    expect(await deliveries(benRow.id)).toBe(1);

    const reply = await removeMember(app, owner.id, circle.id, benRow.id);
    expect(reply.statusCode).toBe(200);
    // The SQL function's jsonb key order.
    expect(reply.body).toBe(
      JSON.stringify({ removed: true, circle_id: circle.id, member_id: benRow.id }),
    );
    expect(await memberRow(client, benRow.id)).toBeUndefined();
    expect(await deliveries(benRow.id)).toBe(0);
    expect(await deliveries(caraRow.id)).toBe(1);
    expect(
      (await getDeliveryCounts(app, owner.id, incident.id as string)).json<Body>().delivered_count,
    ).toBe(1);
    expect(await auditOf(benRow.id)).toEqual([
      {
        action: 'circle.member.removed',
        actor: owner.id,
        target_type: 'circle_member',
        detail: { circle_id: circle.id, member_user_id: ben.id, previous_status: 'active' },
      },
    ]);
    await flush();
    expect(ENDED).toEqual([
      {
        reason: 'removed',
        circle_id: circle.id,
        member_id: benRow.id,
        user_id: ben.id,
        actor_user_id: owner.id,
      },
    ]);
    // Removing it again: gone.
    expectCode(
      await removeMember(app, owner.id, circle.id, benRow.id),
      404,
      'remove_circle_member:not_found',
    );
  });

  it('remove: pending (claimed or not) and declined rows are deleted too', async () => {
    const { owner, circle } = await circleWithMembers();
    const claimer = await createUser(client);
    const pending = await insertMember(client, circle.id, { name: 'Pending One' });
    const claimed = await insertMember(client, circle.id, { userId: claimer.id });
    const declined = await insertMember(client, circle.id, { status: 'declined', canceled: true });
    for (const row of [pending, claimed, declined]) {
      expect((await removeMember(app, owner.id, circle.id, row.id)).statusCode).toBe(200);
      expect(await memberRow(client, row.id)).toBeUndefined();
    }
    const audits = await Promise.all([pending, claimed, declined].map((r) => auditOf(r.id)));
    expect(audits.map((a) => a[0].detail)).toEqual([
      { circle_id: circle.id, member_user_id: null, previous_status: 'pending' },
      { circle_id: circle.id, member_user_id: claimer.id, previous_status: 'pending' },
      { circle_id: circle.id, member_user_id: null, previous_status: 'declined' },
    ]);
    // Never a name, phone or token in the audit detail.
    for (const [audit] of audits) {
      expect(JSON.stringify(audit.detail)).not.toMatch(/Pending One|\+\d{8}|[0-9a-f]{64}/);
    }
  });

  // --- leave (AC2) ---------------------------------------------------------------------------------

  it('leave: codes in the SQL order, nothing written on an error', async () => {
    const { owner, circle, benRow } = await circleWithMembers();
    const outsider = await createUser(client);
    const invitee = await createUser(client);
    const pending = await insertMember(client, circle.id, { userId: invitee.id });
    expectCode(
      await leaveCircle(app, owner.id, '00000000-0000-4000-8000-0000000000fe'),
      404,
      'leave_safety_circle:not_found',
    );
    expectCode(await leaveCircle(app, owner.id, circle.id), 409, 'leave_safety_circle:is_owner');
    expectCode(
      await leaveCircle(app, outsider.id, circle.id),
      403,
      'leave_safety_circle:not_authorized',
    );
    // A pending (claimed) invitee is not an active member.
    expectCode(
      await leaveCircle(app, invitee.id, circle.id),
      403,
      'leave_safety_circle:not_authorized',
    );
    expect(await memberRow(client, pending.id)).toBeDefined();
    expect(await memberRow(client, benRow.id)).toBeDefined();
    expect(ENDED).toEqual([]);
  });

  it('leave: deletes the caller’s row with its deliveries, audits, announces; a second leave is 403', async () => {
    const { owner, circle, ben, benRow, caraRow } = await circleWithMembers();
    await submitAlert(app, owner.id, 'fire');
    const reply = await leaveCircle(app, ben.id, circle.id);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe(
      JSON.stringify({ left: true, circle_id: circle.id, member_id: benRow.id }),
    );
    expect(await memberRow(client, benRow.id)).toBeUndefined();
    expect(await deliveries(benRow.id)).toBe(0);
    expect(await deliveries(caraRow.id)).toBe(1);
    expect(await auditOf(benRow.id)).toEqual([
      {
        action: 'circle.member.left',
        actor: ben.id,
        target_type: 'circle_member',
        detail: { circle_id: circle.id, member_user_id: ben.id, previous_status: 'active' },
      },
    ]);
    await flush();
    expect(ENDED).toEqual([
      {
        reason: 'left',
        circle_id: circle.id,
        member_id: benRow.id,
        user_id: ben.id,
        actor_user_id: ben.id,
      },
    ]);
    expectCode(
      await leaveCircle(app, ben.id, circle.id),
      403,
      'leave_safety_circle:not_authorized',
    );
    // Gone from the joined circles and the member list.
    expect((await listJoinedCircles(app, ben.id)).json<Body[]>()).toEqual([]);
    expectCode(
      await listMembers(app, ben.id, circle.id),
      403,
      'list_circle_members:not_authorized',
    );
    expect(
      (await listMembers(app, owner.id, circle.id)).json<Body[]>().map((m) => m.member_id),
    ).not.toContain(benRow.id);
  });

  // --- AC3: post-commit only, never on rollback; a failing hook never fails the change -------------

  it('a rolled-back end writes nothing and announces nothing', async () => {
    const { owner, circle, ben, benRow } = await circleWithMembers();
    failEndAudit = true;
    expect((await removeMember(app, owner.id, circle.id, benRow.id)).statusCode).toBe(500);
    expect((await leaveCircle(app, ben.id, circle.id)).statusCode).toBe(500);
    await flush();
    expect(await memberRow(client, benRow.id)).toMatchObject({ status: 'active' });
    expect(await auditOf(benRow.id)).toEqual([]);
    expect(ENDED).toEqual([]);
  });

  it('a failing hook does not fail the committed change (logged, ids only)', async () => {
    const { owner, circle, benRow } = await circleWithMembers();
    failHook = true;
    const reply = await removeMember(app, owner.id, circle.id, benRow.id);
    expect(reply.statusCode).toBe(200);
    await flush();
    expect(await memberRow(client, benRow.id)).toBeUndefined();
    const line = logs.lines.find(
      (l) => l.msg === 'membership post-commit hook failed' && l.member_id === benRow.id,
    );
    expect(line).toMatchObject({ reason: 'removed', circle_id: circle.id });
  });

  // --- AC4: every incident read of that circle by that user is 404 afterwards ----------------------

  it.each(['removed', 'left'] as const)(
    'after being %s: 404 on the active incident and on history; gone from the responder list',
    async (how) => {
      const { owner, circle, ben, benRow } = await circleWithMembers();
      const past = (await submitAlert(app, owner.id, 'medical')).json<Body>().id as string;
      expect((await markSafe(app, owner.id, past)).statusCode).toBe(200);
      const live = (await submitAlert(app, owner.id, 'fire')).json<Body>().id as string;

      // Before: Ben reads both.
      expect((await getIncidentDetails(app, ben.id, live)).statusCode).toBe(200);
      expect((await getIncidentDetails(app, ben.id, past)).statusCode).toBe(200);
      expect((await getIncidentEvents(app, ben.id, past)).statusCode).toBe(200);
      expect((await getDeliveryCounts(app, ben.id, live)).statusCode).toBe(200);
      expect((await listResponderIncidents(app, ben.id)).json<Body[]>().map((i) => i.id)).toEqual(
        expect.arrayContaining([live, past]),
      );

      const done =
        how === 'removed'
          ? await removeMember(app, owner.id, circle.id, benRow.id)
          : await leaveCircle(app, ben.id, circle.id);
      expect(done.statusCode).toBe(200);

      for (const id of [live, past]) {
        expectCode(
          await getIncidentDetails(app, ben.id, id),
          404,
          'get_incident_details:not_found',
        );
        expectCode(await getIncidentEvents(app, ben.id, id), 404, 'incident_events:not_found');
        expectCode(
          await getDeliveryCounts(app, ben.id, id),
          404,
          'incident_delivery_counts:not_found',
        );
        expectCode(
          await acknowledgeIncident(app, ben.id, id),
          404,
          'acknowledge_incident:not_found',
        );
      }
      expect((await listResponderIncidents(app, ben.id)).json<Body[]>()).toEqual([]);
      // The resident still reads both, and Cara still sees the live one.
      expect((await getDeliveryCounts(app, owner.id, live)).statusCode).toBe(200);
      expect((await getIncidentEvents(app, owner.id, past)).statusCode).toBe(200);
    },
  );

  // --- locks: the member row only, no circle lock (as the SQL) -------------------------------------

  const lockAndCheck = async (
    lockSql: string,
    params: unknown[],
    call: () => Promise<{ statusCode: number }>,
  ) => {
    await holder.query('begin');
    await holder.query(lockSql, params);
    let settled = false;
    const pending = call().then((reply) => {
      settled = true;
      return reply;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const waited = !settled;
    await holder.query('rollback');
    return { waited, reply: await pending };
  };

  it('remove waits for the member row lock and takes no circle lock', async () => {
    const { owner, circle, benRow, caraRow } = await circleWithMembers();
    const onCircle = await lockAndCheck(
      'select 1 from public.safety_circles where id = $1 for update',
      [circle.id],
      () => removeMember(app, owner.id, circle.id, benRow.id),
    );
    expect(onCircle).toMatchObject({ waited: false, reply: { statusCode: 200 } });
    const onRow = await lockAndCheck(
      'select 1 from public.safety_circle_members where id = $1 for update',
      [caraRow.id],
      () => removeMember(app, owner.id, circle.id, caraRow.id),
    );
    expect(onRow).toMatchObject({ waited: true, reply: { statusCode: 200 } });
  });

  it('leave waits for the member row lock and takes no circle lock', async () => {
    const { circle, ben, benRow, cara, caraRow } = await circleWithMembers();
    const onCircle = await lockAndCheck(
      'select 1 from public.safety_circles where id = $1 for update',
      [circle.id],
      () => leaveCircle(app, ben.id, circle.id),
    );
    expect(onCircle).toMatchObject({ waited: false, reply: { statusCode: 200 } });
    expect(await memberRow(client, benRow.id)).toBeUndefined();
    const onRow = await lockAndCheck(
      'select 1 from public.safety_circle_members where id = $1 for update',
      [caraRow.id],
      () => leaveCircle(app, cara.id, circle.id),
    );
    expect(onRow).toMatchObject({ waited: true, reply: { statusCode: 200 } });
  });

  // --- interchangeable with the SQL functions ------------------------------------------------------

  /** Delivery rows of the circle's incidents (the cascade), for SQL vs API comparisons. */
  const deliveryRows = (circleId: string) => ({
    statement: `select d.incident_id::text, d.member_id::text, d.member_user_id::text,
                       d.acknowledged_at is null as not_acked
                  from public.incident_deliveries d
                  join public.incidents i on i.id = d.incident_id
                 where i.circle_id = $1
                 order by d.member_id`,
    params: [circleId],
  });

  const compareRemove = async (caller: UserFixture, circle: CircleFixture, memberId: string) => {
    const sqlDeliveries = await sqlRolledBack<Body, Body>(
      client,
      caller.id,
      'public.remove_circle_member($1)',
      [memberId],
      deliveryRows(circle.id),
    );
    const compared = await compareWithSql(client, {
      callerId: caller.id,
      sqlCall: 'public.remove_circle_member($1)',
      params: [memberId],
      circleIds: [circle.id],
      api: () => removeMember(app, caller.id, circle.id, memberId),
    });
    const rows = deliveryRows(circle.id);
    expect((await client.query(rows.statement, rows.params)).rows).toEqual(sqlDeliveries.rows);
    return compared;
  };
  const compareLeave = async (caller: UserFixture, circle: CircleFixture) => {
    const sqlDeliveries = await sqlRolledBack<Body, Body>(
      client,
      caller.id,
      'public.leave_safety_circle($1)',
      [circle.id],
      deliveryRows(circle.id),
    );
    const compared = await compareWithSql(client, {
      callerId: caller.id,
      sqlCall: 'public.leave_safety_circle($1)',
      params: [circle.id],
      circleIds: [circle.id],
      api: () => leaveCircle(app, caller.id, circle.id),
    });
    const rows = deliveryRows(circle.id);
    expect((await client.query(rows.statement, rows.params)).rows).toEqual(sqlDeliveries.rows);
    return compared;
  };

  it('remove answers and writes what remove_circle_member does (each code and success)', async () => {
    const { owner, circle, ben, benRow, caraRow } = await circleWithMembers();
    await submitAlert(app, owner.id, 'medical');
    const pending = await insertMember(client, circle.id);
    const declined = await insertMember(client, circle.id, { status: 'declined', canceled: true });
    expect((await compareRemove(ben, circle, caraRow.id)).sqlError).toBe(
      'remove_circle_member:not_authorized',
    );
    expect((await compareRemove(owner, circle, circle.ownerMemberId)).sqlError).toBe(
      'remove_circle_member:cannot_remove_owner',
    );
    expect(
      (await compareRemove(owner, circle, '00000000-0000-4000-8000-0000000000fd')).sqlError,
    ).toBe('remove_circle_member:not_found');
    for (const id of [benRow.id, pending.id, declined.id]) {
      expect((await compareRemove(owner, circle, id)).sqlError).toBeUndefined();
    }
  });

  it('leave answers and writes what leave_safety_circle does (each code and success)', async () => {
    const { owner, circle, ben } = await circleWithMembers();
    await submitAlert(app, owner.id, 'medical');
    const outsider = await createUser(client);
    expect((await compareLeave(owner, circle)).sqlError).toBe('leave_safety_circle:is_owner');
    expect((await compareLeave(outsider, circle)).sqlError).toBe(
      'leave_safety_circle:not_authorized',
    );
    expect((await compareLeave(ben, circle)).sqlError).toBeUndefined();
    expect((await compareLeave(ben, circle)).sqlError).toBe('leave_safety_circle:not_authorized');
    const ghost: CircleFixture = { ...circle, id: '00000000-0000-4000-8000-0000000000fc' };
    expect((await compareLeave(ben, ghost)).sqlError).toBe('leave_safety_circle:not_found');
  });

  it('a row removed through the SQL function is gone for the API, and the reverse', async () => {
    const { owner, circle, ben, benRow, cara, caraRow } = await circleWithMembers();
    // Ben is removed through the SQL function (committed); the API then finds no row.
    await client.query('begin');
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true)`,
      [owner.id, JSON.stringify({ sub: owner.id, role: 'authenticated' })],
    );
    await client.query('select public.remove_circle_member($1)', [benRow.id]);
    await client.query('commit');
    expectCode(
      await removeMember(app, owner.id, circle.id, benRow.id),
      404,
      'remove_circle_member:not_found',
    );
    expectCode(
      await leaveCircle(app, ben.id, circle.id),
      403,
      'leave_safety_circle:not_authorized',
    );
    // Cara leaves through the API; the SQL then answers not_authorized for her.
    expect((await leaveCircle(app, cara.id, circle.id)).statusCode).toBe(200);
    const sql = await sqlRolledBack(client, cara.id, 'public.leave_safety_circle($1)', [circle.id]);
    expect(sql.error).toBe('leave_safety_circle:not_authorized');
    expect(await memberRow(client, caraRow.id)).toBeUndefined();
  });
});
