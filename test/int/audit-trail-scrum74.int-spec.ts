import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { Client } from 'pg';

import { IncidentCloseSweeper } from '../../src/modules/incidents/incident-close-sweeper';
import { AlertDeliveryOutcomes } from '../../src/modules/notifications/alert-delivery-outcomes';
import { FAKE_FAIL_TOKEN_PREFIX } from '../../src/modules/notifications/channels/fake-senders';
import { DeliveriesRepository } from '../../src/modules/notifications/deliveries.repository';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { createTestWorker } from '../../src/testing/test-worker';
import { openTestClient } from '../support/database';
import { fakePushToken, registerDevice } from '../support/device-api';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import {
  acknowledgeIncident,
  markSafe,
  renotifyAlert,
  sendIncidentUpdate,
  setIncidentNotes,
  submitAlert,
} from '../support/incident-api';
import { eventually } from '../support/realtime-client';

/**
 * SCRUM-74 (incident audit trail), decision D75. The real HTTP API and the real worker (fake push
 * adapter, push enabled, retries from 50 ms): every incident event of the story's list writes its
 * row to the append-only `audit_log` (activation, sends, deliveries, acknowledgments, status
 * changes, closure); `incident.delivery_outcome` exactly once per delivery row whatever retries or
 * repeated jobs happen, `incident.delivery_failed_notice` once per failed member; test alerts stay
 * out; the log refuses UPDATE / DELETE / TRUNCATE; the read-only support view
 * `support_incident_audit` (migration 0024) shows the trail in time order and exposes no
 * forbidden column.
 */
type Body = Record<string, unknown>;

const CONFIG = {
  CHANNEL_PUSH_ENABLED: 'true',
  NOTIFICATIONS_RETRY_BASE_DELAY_MS: '50',
  DATABASE_POOL_MAX: '20',
};

interface AuditRow {
  id: string;
  action: string;
  actor_user_id: string | null;
  target_type: string;
  detail: Body;
}

const VIEW_COLUMNS = [
  'incident_id',
  'audit_id',
  'occurred_at',
  'action',
  'actor_user_id',
  'actor_session_id',
  'request_id',
  'detail',
  'resident_id',
  'resident_name',
  'circle_id',
  'emergency_type',
  'incident_status',
];

/** `eventually` with at least 30 s: the worker shares the machine with the other suites. */
const waitLong = (check: () => void | Promise<void>) => eventually(check, 30_000);

describe('incident audit trail (SCRUM-74, D75)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let worker: TestingModule;

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    client = await openTestClient();
    ({ worker } = await createTestWorker(withTestConfig(CONFIG)));
  });

  afterAll(async () => {
    await client.end();
    await worker.close();
    await app.close();
  });

  const query = async <T extends Body>(text: string, values: unknown[] = []) =>
    (await client.query<T>(text, values)).rows;

  const audit = (incidentId: string) =>
    query<AuditRow & Body>(
      `select id::text as id, action, actor_user_id::text as actor_user_id, target_type, detail
         from public.audit_log where target_id = $1 order by occurred_at, id`,
      [incidentId],
    );

  const actionsOf = async (incidentId: string, action: string) =>
    (await audit(incidentId)).filter((row) => row.action === action);

  async function device(user: UserFixture, token: string): Promise<void> {
    const reply = await registerDevice(app, user.id, randomUUID(), {
      platform: 'android',
      app_version: '1.0.0',
      push_provider: 'fcm',
      push_token: token,
    });
    expect(reply.statusCode).toBe(200);
  }

  async function circle(names: string[]): Promise<{
    resident: UserFixture;
    circle: CircleFixture;
    members: UserFixture[];
  }> {
    const resident = await createUser(client, { fullName: 'Rita Resident' });
    const c = await createCircle(client, resident);
    const members: UserFixture[] = [];
    for (const fullName of names) {
      const member = await createUser(client, { fullName });
      await addActiveMember(client, c, member);
      members.push(member);
    }
    return { resident, circle: c, members };
  }

  async function respond(userId: string, incidentId: string, status: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/incidents/${incidentId}/response`,
      headers: { ...(await authHeader(userId)), 'content-type': 'application/json' },
      payload: JSON.stringify({ status }),
    });
  }

  /** The alert rows of the incident are all final (the worker is done with them). */
  async function allFinal(incidentId: string, rows: number): Promise<void> {
    await waitLong(async () => {
      const [r] = await query<{ total: number; open: number }>(
        `select count(*)::int as total, count(*) filter (where status = 'queued')::int as open
           from public.notification_deliveries d
           join public.notification_outbox o on o.id = d.outbox_id
          where d.incident_id = $1 and o.topic in ('incident.created', 'incident.renotified')`,
        [incidentId],
      );
      expect(r).toEqual({ total: rows, open: 0 });
    });
  }

  describe('every AC item writes its audit row', () => {
    let incidentId: string;
    let resident: UserFixture;
    let ada: UserFixture;
    let fay: UserFixture;
    let ned: UserFixture;

    beforeAll(async () => {
      const s = await circle(['Ada Accepts', 'Fay Fails', 'Ned No Phone']);
      resident = s.resident;
      [ada, fay, ned] = s.members;
      await device(ada, fakePushToken('ada74'));
      await device(fay, `${FAKE_FAIL_TOKEN_PREFIX}${randomUUID()}`);

      const submit = await submitAlert(app, resident.id, 'medical');
      expect(submit.statusCode).toBe(201);
      incidentId = submit.json<Body>().id as string;
      await allFinal(incidentId, 3);
      await waitLong(async () => {
        expect(await actionsOf(incidentId, 'incident.delivery_failed_notice')).toHaveLength(2);
      });

      expect((await renotifyAlert(app, resident.id, incidentId)).statusCode).toBe(200);
      await allFinal(incidentId, 6);
      expect((await acknowledgeIncident(app, ada.id, incidentId)).statusCode).toBe(200);
      expect((await respond(ada.id, incidentId, 'responding')).statusCode).toBe(200);
      expect((await respond(fay.id, incidentId, 'unable')).statusCode).toBe(200);
      expect(
        (await sendIncidentUpdate(app, resident.id, incidentId, { preset: 'help_is_here' }))
          .statusCode,
      ).toBe(201);
      expect(
        (await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'Gate code' }))
          .statusCode,
      ).toBe(200);
      expect((await markSafe(app, resident.id, incidentId)).statusCode).toBe(200);
      await client.query(
        `update public.incidents set resolved_at = resolved_at - interval '31 minutes'
          where id = $1`,
        [incidentId],
      );
      await worker.get(IncidentCloseSweeper).sweep();
      expect(
        (await query(`select status from public.incidents where id = $1`, [incidentId]))[0],
      ).toEqual({ status: 'closed' });
    }, 120_000);

    it('activation, sends, acks, status changes and closure: each action once, in order', async () => {
      const others = (await audit(incidentId))
        .map((row) => row.action)
        .filter(
          (a) => a !== 'incident.delivery_outcome' && a !== 'incident.delivery_failed_notice',
        );
      expect(others).toEqual([
        'incident.created',
        'incident.renotified',
        'incident.acknowledged',
        'incident.response_set',
        'incident.response_set',
        'incident.update_sent',
        'incident.notes_set',
        'incident.resolved',
        'incident.closed',
      ]);
      const rows = await audit(incidentId);
      const responses = rows.filter((row) => row.action === 'incident.response_set');
      expect(responses.map((row) => [row.actor_user_id, row.detail.status])).toEqual([
        [ada.id, 'responding'],
        [fay.id, 'unable'],
      ]);
      expect(rows.find((row) => row.action === 'incident.created')!.detail).toMatchObject({
        recipient_count: 3,
      });
      expect(rows.find((row) => row.action === 'incident.closed')).toMatchObject({
        actor_user_id: null,
        detail: { reason: 'safe', auto_closed: false },
      });
      expect(new Set(rows.map((row) => row.target_type))).toEqual(new Set(['incident']));
    });

    it('deliveries: one incident.delivery_outcome per alert row (sent, failed after retries, skipped)', async () => {
      const outcomes = await actionsOf(incidentId, 'incident.delivery_outcome');
      const rows = await query<{ id: string }>(
        `select d.id::text as id from public.notification_deliveries d
           join public.notification_outbox o on o.id = d.outbox_id
          where d.incident_id = $1 and o.topic in ('incident.created', 'incident.renotified')`,
        [incidentId],
      );
      // The resident's "not delivered" pushes (and any other notice) are not delivery outcomes.
      const [others] = await query<{ n: number }>(
        `select count(*)::int as n from public.notification_deliveries d
           join public.notification_outbox o on o.id = d.outbox_id
          where d.incident_id = $1 and o.topic not in ('incident.created', 'incident.renotified')`,
        [incidentId],
      );
      expect(others.n).toBeGreaterThan(0);
      expect(outcomes.map((o) => o.detail.delivery_id).sort()).toEqual(
        rows.map((r) => r.id).sort(),
      );
      const by = (user: UserFixture) =>
        outcomes
          .filter((o) => o.detail.recipient_user_id === user.id)
          .map(
            (o) =>
              `${String(o.detail.status)}|${String(o.detail.error_code)}|${String(o.detail.attempts)}`,
          );
      expect(by(ada)).toEqual(['sent|null|1', 'sent|null|1']);
      expect(by(fay)).toEqual(['failed|fake_unavailable|4', 'failed|fake_unavailable|4']);
      expect(by(ned)).toEqual(['skipped|no_device|0', 'skipped|no_device|0']);
      for (const outcome of outcomes) {
        expect(outcome.actor_user_id).toBeNull();
        expect(Object.keys(outcome.detail).sort()).toEqual(
          [
            'attempts',
            'channel',
            'delivery_id',
            'error_code',
            'recipient_user_id',
            'status',
          ].sort(),
        );
        expect(outcome.detail.channel).toBe('push');
      }
      const text = JSON.stringify(outcomes);
      expect(text).not.toMatch(/fake-|token|Ada|Fay|Ned|medical/i);
    });

    it('the delivery_failed notice: once per failed member, ids and the reason only', async () => {
      const notices = await actionsOf(incidentId, 'incident.delivery_failed_notice');
      expect(
        notices
          .map((n) => [n.actor_user_id, n.detail.member_user_id, n.detail.reason])
          .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      ).toEqual(
        [
          [null, fay.id, 'failed'],
          [null, ned.id, 'no_device'],
        ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      );
      for (const notice of notices) {
        expect(notice.detail).toEqual({
          resident_id: resident.id,
          member_user_id: notice.detail.member_user_id,
          reason: notice.detail.reason,
        });
      }
    });

    it('replays write nothing: repeated status writes, a repeated check, a repeated fan-out', async () => {
      const before = (await audit(incidentId)).length;
      const repository = worker.get(DeliveriesRepository);
      const rows = await query<{ id: string }>(
        `select d.id::text as id from public.notification_deliveries d
           join public.notification_outbox o on o.id = d.outbox_id
          where d.incident_id = $1 and o.topic in ('incident.created', 'incident.renotified')`,
        [incidentId],
      );
      for (const { id } of rows) {
        expect(await repository.markSent(id, 'sent', 'again')).toBeUndefined();
        expect(await repository.recordFailure(id, 'provider_unavailable', true)).toBeUndefined();
        expect(await repository.markSkipped(id, 'no_device')).toBeUndefined();
      }
      const outboxes = await query<{ id: string }>(
        `select id::text as id from public.notification_outbox
          where aggregate_id = $1 and topic in ('incident.created', 'incident.renotified')`,
        [incidentId],
      );
      for (const { id } of outboxes) {
        expect(
          await repository.fanOut({
            outboxId: id,
            incidentId,
            recipients: [ada, fay, ned].map((u) => ({ user_id: u.id, eligible: true })),
            channels: ['push'],
            enabled: { push: true, sms: false, email: false },
          }),
        ).toEqual([]);
      }
      await worker.get(AlertDeliveryOutcomes).afterMemberOutcome(incidentId, [fay.id, ned.id]);
      expect((await audit(incidentId)).length).toBe(before);
    });
  });

  it('auto-close by the sweeper (no activity) writes incident.closed with auto_closed', async () => {
    const s = await circle(['Mo Member']);
    const submit = await submitAlert(app, s.resident.id, 'fire');
    expect(submit.statusCode).toBe(201);
    const incidentId = submit.json<Body>().id as string;
    await allFinal(incidentId, 1);
    await client.query('begin');
    try {
      await client.query('set local session_replication_role = replica');
      await client.query(
        `update public.incidents
            set activated_at = activated_at - interval '25 hours',
                sent_at = sent_at - interval '25 hours',
                updated_at = updated_at - interval '25 hours'
          where id = $1`,
        [incidentId],
      );
      await client.query(
        `update public.incident_deliveries
            set delivered_at = delivered_at - interval '25 hours'
          where incident_id = $1`,
        [incidentId],
      );
      await client.query(
        `update public.safety_circle_members
            set activated_at = activated_at - interval '25 hours'
          where circle_id = $1 and activated_at is not null`,
        [s.circle.id],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    await worker.get(IncidentCloseSweeper).sweep();
    const closed = await actionsOf(incidentId, 'incident.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      actor_user_id: null,
      detail: { auto_closed: true, reason: 'ended', previous_status: 'active' },
    });
  });

  it('a test alert (SCRUM-35) writes no incident.delivery_outcome', async () => {
    const s = await circle(['Tess Tester']);
    await device(s.members[0], fakePushToken('tess74'));
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/me/circle/test-alerts',
      headers: { ...(await authHeader(s.resident.id)), 'idempotency-key': randomUUID() },
    });
    expect(reply.statusCode).toBe(201);
    const testAlertId = reply.json<Body>().id as string;
    await waitLong(async () => {
      const [r] = await query<{ n: number }>(
        `select count(*)::int as n from public.notification_deliveries
          where test_alert_id = $1 and status <> 'queued'`,
        [testAlertId],
      );
      expect(r.n).toBe(1);
    });
    const after = await query<{ n: number }>(
      `select count(*)::int as n from public.audit_log
        where action = 'incident.delivery_outcome'
          and detail ->> 'recipient_user_id' = $1`,
      [s.members[0].id],
    );
    expect(after[0].n).toBe(0);
  });

  describe('immutability', () => {
    it.each([
      ['UPDATE', `update public.audit_log set action = 'tampered' where target_type = 'incident'`],
      ['DELETE', `delete from public.audit_log where target_type = 'incident'`],
      ['TRUNCATE', 'truncate public.audit_log'],
    ])('%s on audit_log is refused', async (_label, statement) => {
      await expect(client.query(statement)).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('audit_log is append-only') as string,
      });
    });

    it.each([
      ['UPDATE', `update public.support_incident_audit set action = 'tampered'`],
      ['DELETE', 'delete from public.support_incident_audit'],
      ['INSERT', `insert into public.support_incident_audit (action) values ('x')`],
    ])('%s through the support view is refused', async (_label, statement) => {
      await expect(client.query(statement)).rejects.toThrow();
    });
  });

  describe('the support view support_incident_audit (migration 0024)', () => {
    it('has exactly the agreed columns: no coordinates, notes, share payloads, phones, tokens or IP', async () => {
      const columns = await query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'support_incident_audit'
          order by ordinal_position`,
      );
      expect(columns.map((c) => c.column_name)).toEqual(VIEW_COLUMNS);
      for (const name of VIEW_COLUMNS.filter((c) => c !== 'emergency_type')) {
        expect(name).not.toMatch(
          /lat|lng|location|coord|note|share|payload|phone|token|email|blood|allerg|medical|ip$/,
        );
      }
    });

    it('is a read-only view, readable by no Supabase API role', async () => {
      const [view] = await query<{ updatable: string; invoker: boolean }>(
        `select v.is_updatable as updatable,
                coalesce('security_invoker=true' = any (c.reloptions), false) as invoker
           from information_schema.views v
           join pg_class c on c.relname = v.table_name
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = v.table_schema
          where v.table_schema = 'public' and v.table_name = 'support_incident_audit'`,
      );
      expect(view).toEqual({ updatable: 'NO', invoker: true });
      const grants = await query<{ grantee: string }>(
        `select grantee from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'support_incident_audit'
            and grantee in ('anon', 'authenticated', 'PUBLIC')`,
      );
      expect(grants).toEqual([]);
    });

    it("shows an incident's whole trail in time order with the incident's ids, name, type and status", async () => {
      const s = await circle(['Vi Viewer']);
      await device(s.members[0], fakePushToken('vi74'));
      const submit = await submitAlert(app, s.resident.id, 'fire');
      const incidentId = submit.json<Body>().id as string;
      await allFinal(incidentId, 1);
      expect((await acknowledgeIncident(app, s.members[0].id, incidentId)).statusCode).toBe(200);
      expect((await markSafe(app, s.resident.id, incidentId)).statusCode).toBe(200);

      const rows = await query<Body>(
        `select incident_id::text as incident_id, audit_id::text as audit_id, action,
                resident_id::text as resident_id, resident_name, circle_id::text as circle_id,
                emergency_type, incident_status, occurred_at
           from public.support_incident_audit where incident_id = $1`,
        [incidentId],
      );
      const trail = await audit(incidentId);
      expect(rows.map((r) => r.audit_id)).toEqual(trail.map((r) => r.id));
      expect(rows.map((r) => r.action)).toEqual([
        'incident.created',
        'incident.delivery_outcome',
        'incident.acknowledged',
        'incident.resolved',
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          incident_id: incidentId,
          resident_id: s.resident.id,
          resident_name: 'Rita Resident',
          circle_id: s.circle.id,
          emergency_type: 'fire',
          incident_status: 'resolved',
        });
      }
      const times = rows.map((r) => new Date(r.occurred_at as string).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });
  });
});
