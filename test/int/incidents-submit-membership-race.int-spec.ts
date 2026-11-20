import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { leaveCircle, removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import { submitAlert } from '../support/incident-api';

/**
 * D14 (Dawit, 2026-11-20): "An SOS must always go through." The API's submit reads the circle's
 * active member rows `FOR KEY SHARE` in its delivery insert, so a member who leaves or is removed at
 * the same moment is simply not notified instead of failing the submit with 23503
 * (`incident_deliveries_member_id_fkey`). The SQL function `submit_emergency_alert` still can fail
 * that way: shown here for contrast, as the Phase 1 deadlock is in phase1-mixed-writers.
 *
 * 1. Deterministic: a leave / remove holds the member row deleted (not yet committed) while a submit
 *    reaches its delivery insert; then the delete commits. API: 201 without that member. SQL: 23503.
 * 2. Many rounds of leave / remove (API and SQL) committing concurrently with API submits: zero
 *    23503, zero 5xx, zero 40P01; every submit 201; recipient lists only hold members that existed.
 */
type Body = Record<string, unknown>;

interface Setup {
  owner: UserFixture;
  circle: CircleFixture;
  ben: UserFixture;
  benRow: MemberFixture;
  cara: UserFixture;
  caraRow: MemberFixture;
  dan: UserFixture;
  danRow: MemberFixture;
}

const ROUNDS = 40;

describe('D14: an SOS always goes through while members leave or are removed', () => {
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
    sqlClients = await Promise.all(Array.from({ length: 4 }, () => openTestClient()));
  });

  afterAll(async () => {
    await Promise.all((sqlClients ?? []).map((c) => c.end()));
    await client?.end();
    await app?.close();
  });

  const circleWithThree = async (): Promise<Setup> => {
    const owner = await createUser(client, { fullName: 'D14 Owner' });
    const circle = await createCircle(client, owner);
    const ben = await createUser(client, { fullName: 'D14 Ben' });
    const cara = await createUser(client, { fullName: 'D14 Cara' });
    const dan = await createUser(client, { fullName: 'D14 Dan' });
    return {
      owner,
      circle,
      ben,
      benRow: await addActiveMember(client, circle, ben),
      cara,
      caraRow: await addActiveMember(client, circle, cara),
      dan,
      danRow: await addActiveMember(client, circle, dan),
    };
  };

  const deadlocks = async () =>
    Number(
      (
        await client.query<{ n: string }>(
          'select deadlocks::text as n from pg_stat_database where datname = current_database()',
        )
      ).rows[0].n,
    );

  async function waitForLockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await client.query<{ n: number }>(
        `select count(distinct pid)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (rows[0].n >= count) return;
      if (Date.now() > deadline) throw new Error(`only ${rows[0].n} of ${count} waiting`);
      await new Promise((done) => setTimeout(done, 10));
    }
  }

  /** Starts `call` as `userId` on `c` in an open transaction (not committed). */
  async function beginSqlAs(c: Client, userId: string, call: string, params: unknown[]) {
    await c.query('begin');
    await c.query(
      `select set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true),
              set_config('TimeZone', 'UTC', true)`,
      [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
    );
    return (await c.query<{ body: Body }>(`select ${call} as body`, params)).rows[0].body;
  }

  /** A whole SQL call in its own transaction; the SQLSTATE when it raises. */
  async function sqlCall(c: Client, userId: string, call: string, params: unknown[]) {
    try {
      const body = await beginSqlAs(c, userId, call, params);
      await c.query('commit');
      return { body, sqlState: undefined as string | undefined, error: undefined };
    } catch (error) {
      await c.query('rollback');
      const { code, message } = error as { code?: string; message?: string };
      return { body: undefined, sqlState: code, error: message };
    }
  }

  /** The `alert_sent` detail of an incident. */
  async function alertSent(incidentId: string) {
    return (
      await client.query<{ detail: { recipient_count: number; recipient_ids: string[] } }>(
        `select detail from public.incident_events
          where incident_id = $1 and event_type = 'alert_sent'`,
        [incidentId],
      )
    ).rows[0].detail;
  }

  const deliveredUsers = async (incidentId: string) =>
    (
      await client.query<{ u: string }>(
        `select member_user_id::text as u from public.incident_deliveries
          where incident_id = $1 order by member_user_id`,
        [incidentId],
      )
    ).rows.map((r) => r.u);

  const submitErrorLogs = () =>
    logs.lines.filter(
      (line) => line.operation === 'submit_emergency_alert' && line.level === 'error',
    ).length;

  describe('deterministic: the member row is deleted between the submit’s read and its check', () => {
    it.each([
      ['leave_safety_circle (SQL)', 'leave'],
      ['remove_circle_member (SQL)', 'remove'],
    ] as const)(
      'API submit while %s is still open: 201, that member is not notified',
      async (_name, how) => {
        const s = await circleWithThree();
        const holder = sqlClients[0];
        if (how === 'leave') {
          await beginSqlAs(holder, s.ben.id, 'public.leave_safety_circle($1)', [s.circle.id]);
        } else {
          await beginSqlAs(holder, s.owner.id, 'public.remove_circle_member($1)', [s.benRow.id]);
        }
        const submitting = submitAlert(app, s.owner.id, 'medical');
        await waitForLockWaiters(1);
        await holder.query('commit');
        const reply = await submitting;

        expect(reply.statusCode).toBe(201);
        const body = reply.json<Body>();
        expect(body).toMatchObject({ submit_outcome: 'created', delivered_count: 2 });
        const expected = [s.cara.id, s.dan.id].sort();
        expect(await deliveredUsers(body.id as string)).toEqual(expected);
        expect(await alertSent(body.id as string)).toEqual({
          recipient_count: 2,
          recipient_ids: expected,
          emergency_type: 'medical',
        });
      },
    );

    it('for contrast: the SQL submit_emergency_alert in the same interleaving fails with 23503', async () => {
      const s = await circleWithThree();
      const holder = sqlClients[0];
      await beginSqlAs(holder, s.ben.id, 'public.leave_safety_circle($1)', [s.circle.id]);
      const submitting = sqlCall(sqlClients[1], s.owner.id, 'public.submit_emergency_alert($1)', [
        'medical',
      ]);
      await waitForLockWaiters(1);
      await holder.query('commit');
      const submitted = await submitting;
      expect(submitted.sqlState).toBe('23503');
      expect(submitted.error).toMatch(/incident_deliveries_member_id_fkey/);
      // Nothing of that submit was kept: the resident has no open incident.
      const open = await client.query(
        `select 1 from public.incidents where resident_id = $1 and status = 'active'`,
        [s.owner.id],
      );
      expect(open.rowCount).toBe(0);
    });

    it('a member removed after the submit locked the rows: the remove waits, then cascades the delivery', async () => {
      const s = await circleWithThree();
      // The submit's locks, held open on another connection: the resident's profile, then the
      // members `FOR KEY SHARE`, exactly as the API's delivery insert takes them.
      const holder = sqlClients[0];
      await holder.query('begin');
      await holder.query(
        `select 1 from public.safety_circle_members where circle_id = $1 and status = 'active'
            for key share`,
        [s.circle.id],
      );
      const removing = removeMember(app, s.owner.id, s.circle.id, s.benRow.id);
      await waitForLockWaiters(1);
      await holder.query('commit');
      expect((await removing).statusCode).toBe(200);
    });
  });

  it(`${ROUNDS} rounds: leave / remove (API and SQL) concurrent with API submits: no 23503, 5xx or 40P01`, async () => {
    const deadlocksBefore = await deadlocks();
    const errorLogsBefore = submitErrorLogs();
    const statuses: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const s = await circleWithThree();
      const initial = new Set([s.ben.id, s.cara.id, s.dan.id]);
      const mode = round % 4;
      // Two members go at the same time as the submit: Ben (mode-dependent writer) and Dan.
      const benGoes =
        mode === 0
          ? leaveCircle(app, s.ben.id, s.circle.id)
          : mode === 1
            ? removeMember(app, s.owner.id, s.circle.id, s.benRow.id)
            : mode === 2
              ? sqlCall(sqlClients[0], s.ben.id, 'public.leave_safety_circle($1)', [s.circle.id])
              : sqlCall(sqlClients[0], s.owner.id, 'public.remove_circle_member($1)', [
                  s.benRow.id,
                ]);
      const danGoes =
        round % 2 === 0
          ? sqlCall(sqlClients[1], s.dan.id, 'public.leave_safety_circle($1)', [s.circle.id])
          : leaveCircle(app, s.dan.id, s.circle.id);
      const [submitted, ben, dan] = await Promise.all([
        submitAlert(app, s.owner.id, 'fire'),
        benGoes,
        danGoes,
      ]);

      for (const other of [ben, dan]) {
        if ('statusCode' in other) expect(other.statusCode).toBe(200);
        else expect([other.sqlState, other.error]).toEqual([undefined, undefined]);
      }
      statuses.push(submitted.statusCode);
      expect(submitted.statusCode).toBe(201);
      const body = submitted.json<Body>();
      const incidentId = body.id as string;
      const sent = await alertSent(incidentId);
      // The recipient list only holds members that existed, and agrees with the response.
      for (const id of sent.recipient_ids) expect(initial.has(id)).toBe(true);
      expect(sent.recipient_ids).toContain(s.cara.id);
      expect(sent.recipient_count).toBe(sent.recipient_ids.length);
      expect(body.delivered_count).toBe(sent.recipient_count);
      // Ben and Dan are gone; their delivery rows (if they were notified) went with them.
      expect(await deliveredUsers(incidentId)).toEqual([s.cara.id]);
    }
    expect(statuses.every((code) => code === 201)).toBe(true);
    expect(submitErrorLogs()).toBe(errorLogsBefore);
    expect(await deadlocks()).toBe(deadlocksBefore);
  });
});
