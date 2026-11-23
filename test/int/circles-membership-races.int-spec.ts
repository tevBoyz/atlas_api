import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  cancelInvite,
  errorOf,
  leaveCircle,
  listMyInvites,
  removeMember,
  resendInvite,
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
import { acknowledgeIncident, markSafe, renotifyAlert, submitAlert } from '../support/incident-api';
import { expectMembershipGone, insertMember, memberRow } from '../support/invite-rows';

/**
 * Concurrency of remove and leave (API-100-32) and of the incoming-list claim (API-100-31) against
 * the writes they can meet on the same rows: acknowledge (locks the caller's delivery row, which the
 * delete cascades to), mark safe, submit and re-notify (incident and delivery rows), and the invite
 * writes (circle row, then member row). API requests run on the app's pool, SQL functions each on
 * their own connection, mixed. Every race ends in one consistent outcome with no deadlock (40P01):
 * a deadlock would surface as a 500 on the API side and SQLSTATE 40P01 on the SQL side, and the
 * database's deadlock counter must not move.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof removeMember>>;
interface SqlResult {
  body?: Body;
  error?: string;
  sqlState?: string;
}

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(500 + counter++).padStart(3, '0')}`;

const ROUNDS = 6;

describe('remove, leave and the incoming-list claim under concurrency (API-100-31/32)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;
  let sqlClients: Client[];

  beforeAll(async () => {
    ({ app, logs } = await createTestApp(
      {},
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
        DATABASE_POOL_MAX: '16',
      }),
    ));
    client = await openTestClient();
    sqlClients = await Promise.all(Array.from({ length: 3 }, () => openTestClient()));
  });

  afterAll(async () => {
    await Promise.all((sqlClients ?? []).map((c) => c.end()));
    await client?.end();
    await app?.close();
  });

  interface Setup {
    owner: UserFixture;
    circle: CircleFixture;
    ben: UserFixture;
    benRow: MemberFixture;
  }
  const circleWithBen = async (): Promise<Setup> => {
    const owner = await createUser(client, { fullName: 'Race Owner' });
    const circle = await createCircle(client, owner);
    const ben = await createUser(client, { fullName: 'Race Ben' });
    const benRow = await addActiveMember(client, circle, ben);
    await addActiveMember(client, circle, await createUser(client));
    return { owner, circle, ben, benRow };
  };

  const deadlocks = async () =>
    Number(
      (
        await client.query<{ n: string }>(
          'select deadlocks::text as n from pg_stat_database where datname = current_database()',
        )
      ).rows[0].n,
    );

  /** A SQL function as `userId` on its own connection; the error and SQLSTATE when it raises. */
  const sqlCall = async (
    c: Client,
    userId: string,
    call: string,
    params: unknown[],
  ): Promise<SqlResult> => {
    await c.query('begin');
    try {
      await c.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true),
                set_config('TimeZone', 'UTC', true)`,
        [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
      );
      const { rows } = await c.query<{ body: Body }>(`select ${call} as body`, params);
      await c.query('commit');
      return { body: rows[0].body };
    } catch (error) {
      await c.query('rollback');
      return { error: (error as Error).message, sqlState: (error as { code?: string }).code };
    }
  };

  const no5xx = (replies: Reply[]) => {
    for (const reply of replies) {
      if (reply.statusCode >= 500) throw new Error(`${reply.statusCode} ${reply.body}`);
    }
  };
  const noSqlDeadlock = (results: SqlResult[]) => {
    for (const result of results) {
      expect(result.sqlState).not.toBe('40P01');
      if (result.error) expect(result.sqlState).toBe('P0001');
    }
  };
  const codeOf = (reply: Reply) => (reply.statusCode >= 400 ? errorOf(reply).code : 'ok');

  /** The owner's SOS with deliveries to the circle's active members (incident id). */
  const sos = async (owner: UserFixture) => {
    const reply = await submitAlert(app, owner.id, 'medical');
    expect(reply.statusCode).toBe(201);
    return reply.json<Body>().id as string;
  };

  it('remove racing the member’s acknowledge (API/API, SQL remove, SQL ack): no deadlock', async () => {
    const before = await deadlocks();
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle, ben, benRow } = await circleWithBen();
      const incident = await sos(owner);
      const mode = round % 3;
      let removeOk: boolean;
      let ack: string;
      if (mode === 0) {
        const [removed, acked] = await Promise.all([
          removeMember(app, owner.id, circle.id, benRow.id),
          acknowledgeIncident(app, ben.id, incident),
        ]);
        no5xx([removed, acked]);
        removeOk = removed.statusCode === 200;
        ack = codeOf(acked);
      } else if (mode === 1) {
        const [removed, acked] = await Promise.all([
          sqlCall(sqlClients[0], owner.id, 'public.remove_circle_member($1)', [benRow.id]),
          acknowledgeIncident(app, ben.id, incident),
        ]);
        no5xx([acked]);
        noSqlDeadlock([removed]);
        removeOk = removed.error === undefined;
        ack = codeOf(acked);
      } else {
        const [removed, acked] = await Promise.all([
          removeMember(app, owner.id, circle.id, benRow.id),
          sqlCall(sqlClients[0], ben.id, 'public.acknowledge_incident($1)', [incident]),
        ]);
        no5xx([removed]);
        noSqlDeadlock([acked]);
        removeOk = removed.statusCode === 200;
        ack = acked.error ?? 'ok';
      }
      expect(removeOk).toBe(true);
      expect(['ok', 'acknowledge_incident:not_found']).toContain(ack);
      await expectMembershipGone(client, benRow.id);
      expect(
        (
          await client.query('select 1 from public.incident_deliveries where member_id = $1', [
            benRow.id,
          ])
        ).rowCount,
      ).toBe(0);
    }
    expect(await deadlocks()).toBe(before);
  });

  it('leave racing the resident’s mark safe (API/API, SQL leave, SQL mark safe): no deadlock', async () => {
    const before = await deadlocks();
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle, ben, benRow } = await circleWithBen();
      const incident = await sos(owner);
      const mode = round % 3;
      if (mode === 0) {
        const replies = await Promise.all([
          leaveCircle(app, ben.id, circle.id),
          markSafe(app, owner.id, incident),
        ]);
        no5xx(replies);
        expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
      } else if (mode === 1) {
        const [left, safe] = await Promise.all([
          sqlCall(sqlClients[0], ben.id, 'public.leave_safety_circle($1)', [circle.id]),
          markSafe(app, owner.id, incident),
        ]);
        noSqlDeadlock([left]);
        no5xx([safe]);
        expect([left.error, safe.statusCode]).toEqual([undefined, 200]);
      } else {
        const [left, safe] = await Promise.all([
          leaveCircle(app, ben.id, circle.id),
          sqlCall(sqlClients[0], owner.id, 'public.mark_incident_safe($1)', [incident]),
        ]);
        no5xx([left]);
        noSqlDeadlock([safe]);
        expect([left.statusCode, safe.error]).toEqual([200, undefined]);
      }
      await expectMembershipGone(client, benRow.id);
      const status = await client.query<{ status: string }>(
        'select status from public.incidents where id = $1',
        [incident],
      );
      expect(status.rows[0].status).toBe('resolved');
    }
    expect(await deadlocks()).toBe(before);
  });

  it('remove racing re-notify of an active incident: no deadlock', async () => {
    const before = await deadlocks();
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle, benRow } = await circleWithBen();
      const incident = await sos(owner);
      const [removed, renotified] = await Promise.all([
        round % 2 === 0
          ? removeMember(app, owner.id, circle.id, benRow.id)
          : sqlCall(sqlClients[0], owner.id, 'public.remove_circle_member($1)', [benRow.id]),
        renotifyAlert(app, owner.id, incident),
      ]);
      no5xx([renotified]);
      if ('statusCode' in removed) no5xx([removed]);
      else noSqlDeadlock([removed]);
      expect(renotified.statusCode).toBe(200);
      await expectMembershipGone(client, benRow.id);
    }
    expect(await deadlocks()).toBe(before);
  });

  it('remove racing accept, resend and cancel of the same invite row (API and SQL mixed): no deadlock', async () => {
    const before = await deadlocks();
    for (let round = 0; round < ROUNDS; round += 1) {
      const sharing = await createUser(client, { fullName: 'Race Sharing Owner' });
      await client.query(
        'update public.profiles set location_sharing_enabled = true where id = $1',
        [sharing.id],
      );
      const circle = await createCircle(client, sharing);
      const joiner = await createUser(client);
      const rows = [
        await insertMember(client, circle.id),
        await insertMember(client, circle.id),
        await insertMember(client, circle.id),
      ];
      const viaSql = round % 2 === 1;
      const [r1, r2, r3, accept, resend, cancel] = await Promise.all([
        removeMember(app, sharing.id, circle.id, rows[0].id),
        viaSql
          ? sqlCall(sqlClients[0], sharing.id, 'public.remove_circle_member($1)', [rows[1].id])
          : removeMember(app, sharing.id, circle.id, rows[1].id),
        removeMember(app, sharing.id, circle.id, rows[2].id),
        viaSql
          ? sqlCall(sqlClients[1], joiner.id, 'public.accept_circle_invite($1)', [rows[0].token])
          : acceptInvite(app, joiner.id, rows[0].token),
        resendInvite(app, sharing.id, rows[1].id),
        viaSql
          ? sqlCall(sqlClients[2], sharing.id, 'public.cancel_circle_invite($1)', [rows[2].id])
          : cancelInvite(app, sharing.id, rows[2].id),
      ]);
      const replies = [r1, r2, r3, accept, resend, cancel].filter(
        (r): r is Reply => 'statusCode' in r,
      );
      const sqlResults = [r1, r2, r3, accept, resend, cancel].filter(
        (r): r is SqlResult => !('statusCode' in r),
      );
      no5xx(replies);
      noSqlDeadlock(sqlResults);
      const outcome = (r: Reply | SqlResult) => ('statusCode' in r ? codeOf(r) : (r.error ?? 'ok'));
      // Remove always wins in the end (it deletes whatever the other write left).
      for (const removed of [r1, r2, r3]) expect(outcome(removed)).toBe('ok');
      expect(['ok', 'accept_circle_invite:not_found']).toContain(outcome(accept));
      expect(['ok', 'resend_circle_invite:member_not_found']).toContain(outcome(resend));
      expect(['ok', 'cancel_circle_invite:not_found']).toContain(outcome(cancel));
      for (const row of rows) await expectMembershipGone(client, row.id);
    }
    expect(await deadlocks()).toBe(before);
  });

  /**
   * Leave racing submit. No deadlock is possible (leave locks the member row, submit's delivery
   * insert takes `FOR KEY SHARE` on it; neither then waits on the other). When the leave deletes the
   * row after the SQL `submit_emergency_alert` read the active members and before its foreign key
   * check, that check fails with 23503 (`incident_deliveries_member_id_fkey`). Since D14
   * (2026-11-20) the API reads the member rows `FOR KEY SHARE` before its insert, so the API submit
   * always succeeds (the leaver is simply not notified); only the SQL side may still fail with 23503.
   * The full D14 proof is incidents-submit-membership-race.int-spec.ts.
   *
   * Since D44 (2026-11-22) the API leave keeps the member row (`status = 'left'`, `ended_at` set)
   * and deletes the member's `incident_deliveries` instead of deleting the row. The API submit
   * waits behind the leave's row lock and then skips Ben (no longer active), so it never keeps a
   * delivery of him. The old SQL `submit_emergency_alert` reads the active members without a lock:
   * when it read Ben as active before the API leave committed and inserts after it, the insert now
   * succeeds (the row still exists, so no 23503) and that one delivery survives. The app no longer
   * calls that SQL function (D13; its grants are revoked by 0012), so this is a deliberate
   * consequence of D44, not an app bug: in the API-leave + SQL-submit rounds 0 or 1 surviving
   * delivery is accepted (1 only with `sql:ok`); every other round still requires 0.
   */
  it('leave racing the resident’s submit (API and SQL mixed): no deadlock; the API submit always succeeds (D14), the SQL one fails only with 23503', async () => {
    const before = await deadlocks();
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS * 2; round += 1) {
      const { owner, circle, ben, benRow } = await circleWithBen();
      const mode = round % 4;
      const [left, submitted] = await Promise.all([
        mode % 2 === 1
          ? sqlCall(sqlClients[0], ben.id, 'public.leave_safety_circle($1)', [circle.id])
          : leaveCircle(app, ben.id, circle.id),
        mode >= 2
          ? sqlCall(sqlClients[1], owner.id, 'public.submit_emergency_alert($1)', ['fire'])
          : submitAlert(app, owner.id, 'fire'),
      ]);
      if ('statusCode' in left) {
        no5xx([left]);
        expect(left.statusCode).toBe(200);
      } else {
        noSqlDeadlock([left]);
        expect(left.error).toBeUndefined();
      }
      if ('statusCode' in submitted) {
        expect(submitted.statusCode).toBe(201);
        outcomes.push('api:201');
      } else {
        expect(submitted.sqlState).not.toBe('40P01');
        if (submitted.error) expect(submitted.sqlState).toBe('23503');
        outcomes.push(submitted.error ? 'sql:23503' : 'sql:ok');
      }
      await expectMembershipGone(client, benRow.id);
      const survivors = (
        await client.query('select 1 from public.incident_deliveries where member_id = $1', [
          benRow.id,
        ])
      ).rowCount;
      if (mode === 2) {
        // API leave (D44: the row stays as `left`) racing the old SQL submit (no lock on its read):
        // at most one delivery of Ben may survive, and only when that submit went through.
        expect([0, 1]).toContain(survivors);
        if (survivors === 1) expect(outcomes[outcomes.length - 1]).toBe('sql:ok');
      } else {
        // The API submit (D14) never keeps a delivery of the leaver; the SQL leave deletes the row,
        // so its cascade (or the 23503) leaves none either.
        expect(survivors).toBe(0);
      }
    }
    expect(outcomes.every((o) => ['api:201', 'sql:ok', 'sql:23503'].includes(o))).toBe(true);
    expect(
      logs.lines.filter(
        (line) => line.operation === 'submit_emergency_alert' && line.level === 'error',
      ),
    ).toEqual([]);
    expect(await deadlocks()).toBe(before);
  });

  it('the incoming-list claim: API and SQL lists of one user, racing accepts and removes of the same rows: no deadlock', async () => {
    const before = await deadlocks();
    for (let round = 0; round < ROUNDS; round += 1) {
      const phone = phoneNumber();
      const invitee = await createUser(client, { phone });
      const owners = await Promise.all([1, 2, 3, 4].map(() => createUser(client)));
      const circles = await Promise.all(owners.map((o) => createCircle(client, o)));
      const rows = await Promise.all(circles.map((c) => insertMember(client, c.id, { phone })));
      const [api1, viaSql, api2, accepted, removed] = await Promise.all([
        listMyInvites(app, invitee.id),
        sqlCall(sqlClients[0], invitee.id, 'public.list_my_circle_invites()', []),
        listMyInvites(app, invitee.id),
        round % 2 === 0
          ? acceptInvite(app, invitee.id, rows[0].token)
          : sqlCall(sqlClients[1], invitee.id, 'public.accept_circle_invite($1)', [rows[0].token]),
        removeMember(app, owners[1].id, circles[1].id, rows[1].id),
      ]);
      no5xx([api1, api2, removed]);
      noSqlDeadlock([viaSql]);
      if ('statusCode' in accepted) no5xx([accepted]);
      else noSqlDeadlock([accepted]);
      expect(removed.statusCode).toBe(200);
      // The accept always succeeds (the invitee is the recipient, claimed or not).
      expect('statusCode' in accepted ? accepted.statusCode : accepted.error).toBe(
        'statusCode' in accepted ? 200 : undefined,
      );
      expect(await memberRow(client, rows[0].id)).toMatchObject({
        status: 'active',
        user_id: invitee.id,
      });
      // The two untouched rows end claimed by the invitee, still pending.
      for (const row of rows.slice(2)) {
        expect(await memberRow(client, row.id)).toMatchObject({
          status: 'pending',
          user_id: invitee.id,
        });
      }
      // A list after the dust settles: the two pending rows (newest first by insertion).
      const listed = (await listMyInvites(app, invitee.id)).json<Body[]>();
      expect(new Set(listed.map((x) => x.member_id))).toEqual(
        new Set(rows.slice(2).map((r) => r.id)),
      );
    }
    expect(await deadlocks()).toBe(before);
  });
});
