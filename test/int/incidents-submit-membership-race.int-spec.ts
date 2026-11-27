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
 * (`incident_deliveries_member_id_fkey`).
 *
 * 1. Deterministic: another transaction holds the member row deleted, or ended as `left` (D44), not
 *    yet committed, while a submit reaches its delivery insert; then it commits. 201 without that
 *    member.
 * 2. Many rounds of leave / remove committing concurrently with submits: zero 23503, zero 5xx;
 *    every submit 201; recipient lists only hold members that existed. Outcomes are asserted, not
 *    the database-wide deadlock counter (gap 32).
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
  let holder: Client;

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
    holder = await openTestClient();
  });

  afterAll(async () => {
    await holder?.end();
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
        // Stage 2 [B13]: rows of an ended membership are kept as history; the live ones count.
        `select d.member_user_id::text as u from public.incident_deliveries d
           join public.safety_circle_members m on m.id = d.member_id and m.status = 'active'
          where d.incident_id = $1 order by d.member_user_id`,
        [incidentId],
      )
    ).rows.map((r) => r.u);

  const submitErrorLogs = () =>
    logs.lines.filter(
      (line) => line.operation === 'submit_emergency_alert' && line.level === 'error',
    ).length;

  describe('deterministic: the member row is deleted between the submit’s read and its check', () => {
    it.each([
      ['the member row ended as left (D44)', 'leave'],
      ['the member row deleted', 'delete'],
    ] as const)(
      'API submit while %s is still uncommitted: 201, that member is not notified',
      async (_name, how) => {
        const s = await circleWithThree();
        await holder.query('begin');
        if (how === 'leave') {
          // As the API's leave: the row locked FOR UPDATE, then ended.
          await holder.query(
            'select 1 from public.safety_circle_members where id = $1 for update',
            [s.benRow.id],
          );
          await holder.query(
            `update public.safety_circle_members
                set status = 'left', ended_at = now(), updated_at = now()
              where id = $1`,
            [s.benRow.id],
          );
        } else {
          await holder.query('delete from public.safety_circle_members where id = $1', [
            s.benRow.id,
          ]);
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

    it('a member removed after the submit locked the rows: the remove waits, then cascades the delivery', async () => {
      const s = await circleWithThree();
      // The submit's locks, held open on another connection: the resident's profile, then the
      // members `FOR KEY SHARE`, exactly as the API's delivery insert takes them.
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

  it(`${ROUNDS} rounds: leave / remove concurrent with submits: no 23503, no 5xx`, async () => {
    const errorLogsBefore = submitErrorLogs();
    const statuses: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const s = await circleWithThree();
      const initial = new Set([s.ben.id, s.cara.id, s.dan.id]);
      // Two members go at the same time as the submit: Ben (left or removed) and Dan (left).
      const benGoes =
        round % 2 === 0
          ? leaveCircle(app, s.ben.id, s.circle.id)
          : removeMember(app, s.owner.id, s.circle.id, s.benRow.id);
      const danGoes = leaveCircle(app, s.dan.id, s.circle.id);
      const [submitted, ben, dan] = await Promise.all([
        submitAlert(app, s.owner.id, 'fire'),
        benGoes,
        danGoes,
      ]);

      for (const other of [ben, dan]) expect(other.statusCode).toBe(200);
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
      // Ben and Dan are gone; their rows (if they were notified) are history, not live.
      expect(await deliveredUsers(incidentId)).toEqual([s.cara.id]);
    }
    expect(statuses.every((code) => code === 201)).toBe(true);
    expect(submitErrorLogs()).toBe(errorLogsBefore);
  });
});
