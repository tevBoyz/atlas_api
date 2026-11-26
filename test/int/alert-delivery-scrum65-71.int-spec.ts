import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type { Client } from 'pg';

import { DatabaseService } from '../../src/db/database.service';
import { OutboxRelay } from '../../src/jobs/outbox-relay.service';
import {
  type MemberDelivery,
  memberDeliverySql,
} from '../../src/modules/incidents/incident-delivery-status';
import { AlertDeliveryOutcomes } from '../../src/modules/notifications/alert-delivery-outcomes';
import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import {
  FAKE_FAIL_TOKEN_PREFIX,
  type FakePushSender,
} from '../../src/modules/notifications/channels/fake-senders';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { WorkerRealtimeEmitter } from '../../src/realtime/worker-realtime-emitter';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { createTestWorker } from '../../src/testing/test-worker';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import { fakePushToken, registerDevice } from '../support/device-api';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import { getIncidentEvents, markSafe, renotifyAlert, submitAlert } from '../support/incident-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * SCRUM-65 (delivery confirmation), 66 (retries), 67 (delivery tracking) and 71 (failed alert
 * notice), decision D73. The real HTTP API and the real worker (fake push adapter, push enabled,
 * retries from 50 ms so a failing token is final within about a second):
 * - the member status rule (multi-device, no device, retrying, failed after retries, a re-notify
 *   recovers; other notices never count);
 * - the 3 delivery keys on the resident's responder rows only (REST and `incident.responders`);
 * - one `incident.delivery_failed` + one push to the resident per failed member, never after the
 *   alert ended, never visible to members (no event row, no member payload);
 * - `final_at` on every final row; one outcome log line per final row with exactly its 7 keys.
 */
type Body = Record<string, unknown>;

const CONFIG = {
  CHANNEL_PUSH_ENABLED: 'true',
  NOTIFICATIONS_RETRY_BASE_DELAY_MS: '50',
  DATABASE_POOL_MAX: '20',
};
const MEMBER_KEYS = [
  'user_id',
  'display_name',
  'avatar_url',
  'status',
  'acknowledged_at',
  'status_at',
  'is_me',
];
const RESIDENT_KEYS = [...MEMBER_KEYS, 'delivery_status', 'delivery_at', 'delivery_failed_reason'];
const OUTCOME_KEYS = [
  'delivery_id',
  'topic',
  'channel',
  'status',
  'error_code',
  'attempts',
  'incident_id',
].sort();

/** `eventually` with at least 30 s: the worker shares the machine with the other suites. */
const waitLong = (check: () => void | Promise<void>, ms = 30_000) =>
  eventually(check, Math.max(ms, 30_000));

describe('alert delivery status and the failed alert notice (SCRUM-65/66/67/71, D73)', () => {
  let app: NestFastifyApplication;
  let url: string;
  let client: Client;
  let worker: TestingModule | undefined;
  let workerLogs: LogCapture;
  const open: TestSocket[] = [];
  const tokens: string[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    client = await openTestClient();
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client.end();
    await worker?.close();
    await app.close();
  });

  /**
   * The worker is started by the first scenario only after the sockets joined the incident (the
   * app's relay has already queued the alert), so no broadcast can happen before the join.
   */
  async function startWorker(): Promise<TestingModule> {
    if (!worker) {
      ({ worker, logs: workerLogs } = await createTestWorker(withTestConfig(CONFIG)));
      await waitLong(async () => {
        await app.get(RealtimeGateway).ping();
        await worker!.get(WorkerRealtimeEmitter).ping();
      });
    }
    return worker;
  }

  const push = () => worker!.get(ChannelSenders).push as FakePushSender;

  async function device(user: UserFixture, token: string): Promise<void> {
    tokens.push(token);
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

  async function responders(userId: string, incidentId: string): Promise<Body[]> {
    const reply = await app.inject({
      method: 'GET',
      url: `/v1/incidents/${incidentId}/responders`,
      headers: await authHeader(userId),
    });
    expect(reply.statusCode).toBe(200);
    return reply.json<Body[]>();
  }

  /** The resident's rows by user id: `status|at set|reason`. */
  async function statusOf(residentId: string, incidentId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const row of await responders(residentId, incidentId)) {
      out[row.user_id as string] =
        `${String(row.delivery_status)}|${row.delivery_at === null ? 'null' : 'at'}|${String(row.delivery_failed_reason)}`;
    }
    return out;
  }

  const query = async <T extends Body>(text: string, values: unknown[] = []) =>
    (await client.query<T>(text, values)).rows;

  const notices = (incidentId: string) =>
    query<{ id: string; payload: Body }>(
      `select id, payload from public.notification_outbox
        where aggregate_id = $1 and topic = 'incident.delivery_failed' order by created_at, id`,
      [incidentId],
    );

  it('SOS: multi-device delivered, no device and failed-after-retries failed; one notice + one resident push each; members see nothing new', async () => {
    const { resident, members } = await circle(['Ada Two Phones', 'Ned No Phone', 'Fay Fails']);
    const [ada, ned, fay] = members;
    await device(resident, fakePushToken('rita'));
    await device(ada, `${FAKE_FAIL_TOKEN_PREFIX}${randomUUID()}`);
    await device(ada, fakePushToken('ada'));
    await device(fay, `${FAKE_FAIL_TOKEN_PREFIX}${randomUUID()}`);

    const submit = await submitAlert(app, resident.id, 'medical');
    expect(submit.statusCode).toBe(201);
    const incidentId = submit.json<Body>().id as string;

    // Before the worker ran: nothing fanned out yet -> every member is "sent" (not failed).
    const before = await responders(resident.id, incidentId);
    expect(before.map((r) => Object.keys(r))).toEqual(before.map(() => RESIDENT_KEYS));
    expect(new Set(before.map((r) => r.delivery_status))).toEqual(new Set(['sent']));

    const rita = await connectSocket(url, resident.id);
    const adaSock = await connectSocket(url, ada.id);
    open.push(rita, adaSock);
    expect(await rita.join(incidentId)).toEqual({ ok: true });
    expect(await adaSock.join(incidentId)).toEqual({ ok: true });
    await startWorker();

    await waitLong(async () => {
      expect(await statusOf(resident.id, incidentId)).toEqual({
        [ada.id]: 'delivered|at|null',
        [ned.id]: 'failed|at|no_device',
        [fay.id]: 'failed|at|failed',
      });
    }, 20_000);

    // delivery_at: delivered = the first acceptance; failed = the final time of the rows.
    const rows = await responders(resident.id, incidentId);
    const at = (id: string) => rows.find((r) => r.user_id === id)!.delivery_at as string;
    const times = await query<{ user: string; first_sent: string; last_final: string }>(
      `select recipient_user_id::text as user,
              to_jsonb(min(sent_at) filter (where status in ('sent','delivered'))) #>> '{}' as first_sent,
              to_jsonb(max(final_at)) #>> '{}' as last_final
         from public.notification_deliveries
        where incident_id = $1 and channel = 'push' and recipient_user_id <> $2
        group by recipient_user_id`,
      [incidentId, resident.id],
    );
    const t = (id: string) => times.find((x) => x.user === id)!;
    expect(Date.parse(at(ada.id))).toBe(Date.parse(t(ada.id).first_sent));
    expect(Date.parse(at(ned.id))).toBe(Date.parse(t(ned.id).last_final));
    expect(Date.parse(at(fay.id))).toBe(Date.parse(t(fay.id).last_final));
    // SCRUM-66: Fay's row failed after 1 + 3 attempts with the last error code.
    const [fayRow] = await query<{ status: string; error_code: string; attempts: number }>(
      `select status, error_code, attempts from public.notification_deliveries
        where incident_id = $1 and recipient_user_id = $2`,
      [incidentId, fay.id],
    );
    expect(fayRow).toEqual({ status: 'failed', error_code: 'fake_unavailable', attempts: 4 });

    // SCRUM-71: exactly one notice per failed member (Ned, Fay), none for Ada.
    await waitLong(async () => {
      expect((await notices(incidentId)).length).toBe(2);
    });
    const marked = await query<{ member_user_id: string; at: boolean }>(
      `select member_user_id::text as member_user_id, delivery_failed_notified_at is not null as at
         from public.incident_deliveries where incident_id = $1 order by member_user_id`,
      [incidentId],
    );
    expect(Object.fromEntries(marked.map((m) => [m.member_user_id, m.at]))).toEqual({
      [ada.id]: false,
      [ned.id]: true,
      [fay.id]: true,
    });
    const payloads = (await notices(incidentId)).map((n) => n.payload);
    expect(payloads.map((p) => p.member_name).sort()).toEqual(['Fay Fails', 'Ned No Phone']);
    for (const payload of payloads) {
      expect(Object.keys(payload).sort()).toEqual(
        ['incident_id', 'member_name', 'occurred_at', 'reason', 'recipient_user_ids'].sort(),
      );
      expect(payload.recipient_user_ids).toEqual([resident.id]);
    }

    // The resident's push: one per notice, sent through the fake, title and body as D73.
    await waitLong(async () => {
      const residentRows = await query<{ status: string; channel: string }>(
        `select d.status, d.channel from public.notification_deliveries d
           join public.notification_outbox o on o.id = d.outbox_id
          where o.aggregate_id = $1 and o.topic = 'incident.delivery_failed'`,
        [incidentId],
      );
      expect(residentRows).toEqual([
        { status: 'sent', channel: 'push' },
        { status: 'sent', channel: 'push' },
      ]);
    }, 10_000);
    const residentPushes = push().sent.filter(
      (s) =>
        (s.content as Body).topic === 'incident.delivery_failed' &&
        (s.content as Body).incident_id === incidentId,
    );
    expect(
      residentPushes.map((s) => s.text).sort((a, b) => a!.body.localeCompare(b!.body)),
    ).toEqual([
      { title: 'Alert not delivered', body: "Fay Fails didn't receive your alert" },
      { title: 'Alert not delivered', body: "Ned No Phone didn't receive your alert" },
    ]);
    expect(new Set(residentPushes.map((s) => s.to.token))).toEqual(new Set([tokens[0]]));

    // Live: incident.delivery_failed to the resident only (Ned and Fay), with the contract keys.
    const live = [await rita.next<Body>('incident.delivery_failed')];
    live.push(await rita.next<Body>('incident.delivery_failed'));
    for (const payload of live) {
      expect(Object.keys(payload)).toEqual(['incident_id', 'member', 'reason', 'occurred_at']);
      expect(Object.keys(payload.member as Body)).toEqual(['user_id', 'display_name']);
    }
    expect(
      live
        .map(
          (p) =>
            `${(p.member as Body).user_id as string}:${(p.member as Body).display_name as string}:${p.reason as string}`,
        )
        .sort(),
    ).toEqual([`${fay.id}:Fay Fails:failed`, `${ned.id}:Ned No Phone:no_device`].sort());
    // The resident's responder rows arrived live with the delivery keys.
    await waitLong(() => {
      const last = new Map<string, Body>();
      for (const p of rita.of<Body>('incident.responders')) {
        const r = p.responder as Body;
        last.set(r.user_id as string, r);
      }
      expect(Object.keys(last.get(ada.id) ?? {})).toEqual(RESIDENT_KEYS);
      expect(last.get(ada.id)?.delivery_status).toBe('delivered');
      expect(last.get(ned.id)?.delivery_status).toBe('failed');
      expect(last.get(fay.id)?.delivery_status).toBe('failed');
    });
    await sleep(300);
    // Members see nothing new: no delivery_failed, no responders refresh, no delivery keys.
    expect(adaSock.of('incident.delivery_failed')).toEqual([]);
    expect(adaSock.of('incident.responders')).toEqual([]);
    for (const member of members) {
      const list = await responders(member.id, incidentId);
      expect(list.map((r) => Object.keys(r))).toEqual(list.map(() => MEMBER_KEYS));
    }
    for (const userId of [resident.id, ada.id]) {
      const events = (await getIncidentEvents(app, userId, incidentId)).json<Body[]>();
      expect(events.map((e) => e.event_type)).toEqual(['alert_sent', 'location_sharing_started']);
    }

    // SCRUM-67: final_at on every final row (null exactly while queued); sent rows: = sent_at.
    const shape = await query<{ bad: string; sent_mismatch: string; total: string }>(
      `select count(*) filter (where (status = 'queued') <> (final_at is null))::text as bad,
              count(*) filter (where status in ('sent','delivered') and final_at <> sent_at)::text
                as sent_mismatch,
              count(*)::text as total
         from public.notification_deliveries where incident_id = $1`,
      [incidentId],
    );
    expect(shape[0]).toEqual({ bad: '0', sent_mismatch: '0', total: '6' });
    // One outcome line per final row, exactly the 7 keys; no token or name in the worker log.
    const ids = await query<{ id: string }>(
      'select id::text as id from public.notification_deliveries where incident_id = $1',
      [incidentId],
    );
    for (const { id } of ids) {
      const lines = workerLogs.lines.filter(
        (line) => line.msg === 'delivery outcome' && line.delivery_id === id,
      );
      expect(lines).toHaveLength(1);
      const fields = Object.keys(lines[0]).filter(
        (key) =>
          !['level', 'time', 'pid', 'hostname', 'msg', 'service', 'env', 'version'].includes(key),
      );
      expect(fields.sort()).toEqual(OUTCOME_KEYS);
    }
    for (const secret of [...tokens, 'Fay Fails', 'Ned No Phone', 'Rita Resident']) {
      expect(workerLogs.text).not.toContain(secret);
    }
  }, 120_000);

  it('a re-notify recomputes: the failed member with a device now becomes delivered; still one notice', async () => {
    await startWorker();
    const { resident, members } = await circle(['Ned Later Phone']);
    const [ned] = members;
    const incidentId = (await submitAlert(app, resident.id, 'fire')).json<Body>().id as string;
    await waitLong(async () => {
      expect(await statusOf(resident.id, incidentId)).toEqual({ [ned.id]: 'failed|at|no_device' });
      expect((await notices(incidentId)).length).toBe(1);
    }, 30_000);

    const rita = await connectSocket(url, resident.id);
    open.push(rita);
    expect(await rita.join(incidentId)).toEqual({ ok: true });
    await device(ned, fakePushToken('ned'));
    const renotifiedAt = Date.now();
    expect((await renotifyAlert(app, resident.id, incidentId)).statusCode).toBe(200);
    await waitLong(async () => {
      expect(await statusOf(resident.id, incidentId)).toEqual({ [ned.id]: 'delivered|at|null' });
    }, 30_000);
    // Live: Ned's row reaches Rita again (sent after the re-notify's fan-out, then delivered).
    await waitLong(() => {
      const rows = rita.of<Body>('incident.responders').map((p) => p.responder as Body);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.user_id === ned.id)).toBe(true);
      expect(rows.at(-1)!.delivery_status).toBe('delivered');
    }, 15_000);
    await sleep(300);
    expect((await notices(incidentId)).length).toBe(1);
    // No new notice live either. The FIRST notice's broadcast may still reach Rita after she joined
    // (it is published by the worker after its commit); only a notice of the re-notify would be new.
    const live = rita.of<Body>('incident.delivery_failed');
    expect(live.filter((p) => Date.parse(p.occurred_at as string) >= renotifiedAt)).toEqual([]);
  }, 90_000);

  it('a member who fails again after a re-notify is not reported twice (one notice per member per alert)', async () => {
    const w = await startWorker();
    const { resident, members } = await circle(['Ned Twice']);
    const [ned] = members;
    const incidentId = (await submitAlert(app, resident.id, 'other')).json<Body>().id as string;
    await waitLong(async () => expect((await notices(incidentId)).length).toBe(1), 15_000);
    expect((await renotifyAlert(app, resident.id, incidentId)).statusCode).toBe(200);
    await waitLong(async () => {
      expect(await statusOf(resident.id, incidentId)).toEqual({ [ned.id]: 'failed|at|no_device' });
      const renotified = await query<{ n: string }>(
        `select count(*)::text as n from public.notification_deliveries d
           join public.notification_outbox o on o.id = d.outbox_id
          where o.aggregate_id = $1 and o.topic = 'incident.renotified'`,
        [incidentId],
      );
      expect(renotified[0].n).toBe('1');
    }, 15_000);
    // Repeated and concurrent re-checks never add a notice.
    const outcomes = w.get(AlertDeliveryOutcomes);
    await Promise.all(
      Array.from({ length: 5 }, () => outcomes.afterMemberOutcome(incidentId, [ned.id])),
    );
    expect((await notices(incidentId)).length).toBe(1);
  }, 90_000);

  it('no notice after the alert ended; a notice row of an ended alert reaches nobody', async () => {
    const w = await startWorker();
    const { resident, members } = await circle(['Ada Delivered']);
    const [ada] = members;
    await device(ada, fakePushToken('ada2'));
    await device(resident, fakePushToken('rita2'));
    const incidentId = (await submitAlert(app, resident.id, 'medical')).json<Body>().id as string;
    await waitLong(async () => {
      expect(await statusOf(resident.id, incidentId)).toEqual({ [ada.id]: 'delivered|at|null' });
    }, 15_000);
    expect((await markSafe(app, resident.id, incidentId)).statusCode).toBe(200);
    // Ada's alert rows turn failed after the close (as if the provider had refused them): the
    // status is failed, but no notice is recorded or sent.
    await client.query(
      `update public.notification_deliveries d set status = 'failed', error_code = 'timeout'
         from public.notification_outbox o
        where o.id = d.outbox_id and o.topic in ('incident.created','incident.renotified')
          and d.incident_id = $1`,
      [incidentId],
    );
    await w.get(AlertDeliveryOutcomes).afterMemberOutcome(incidentId, [ada.id]);
    expect(await statusOf(resident.id, incidentId)).toEqual({ [ada.id]: 'failed|at|failed' });
    expect(await notices(incidentId)).toEqual([]);
    const [mark] = await query<{ at: string | null }>(
      `select delivery_failed_notified_at::text as at from public.incident_deliveries
        where incident_id = $1`,
      [incidentId],
    );
    expect(mark.at).toBeNull();

    // A notice row written while active but fanned out after the close: skipped not_eligible.
    const [{ id: outboxId }] = await query<{ id: string }>(
      `insert into public.notification_outbox (topic, aggregate_id, payload)
       values ('incident.delivery_failed', $1, jsonb_build_object(
         'incident_id', $1::uuid, 'member_name', 'Ada Delivered', 'reason', 'failed',
         'occurred_at', now(), 'recipient_user_ids', jsonb_build_array($2::uuid)))
       returning id::text as id`,
      [incidentId, resident.id],
    );
    await app.get(OutboxRelay).flush();
    await waitLong(async () => {
      const rows = await query<{ recipient: string; status: string; error_code: string }>(
        `select recipient_user_id::text as recipient, status, error_code
           from public.notification_deliveries where outbox_id = $1`,
        [outboxId],
      );
      expect(rows).toEqual([
        { recipient: resident.id, status: 'skipped', error_code: 'not_eligible' },
      ]);
    }, 10_000);
  }, 90_000);

  describe('the status rule (memberDeliverySql) on crafted rows', () => {
    const incidentId = randomUUID();

    async function outbox(topic: string, members: string[]): Promise<string> {
      const [{ id }] = await query<{ id: string }>(
        // Marked published: the running relays and worker must never pick these rows up.
        `insert into public.notification_outbox (topic, aggregate_id, payload, published_at)
         values ($1, $2, jsonb_build_object('incident_id', $2::uuid, 'recipient_user_ids', $3::jsonb),
                 now())
         returning id::text as id`,
        [topic, incidentId, JSON.stringify(members)],
      );
      return id;
    }

    async function row(
      outboxId: string,
      member: string,
      status: string,
      options: { channel?: string; error?: string | null; at?: string } = {},
    ): Promise<void> {
      const error =
        options.error !== undefined
          ? options.error
          : status === 'failed'
            ? 'timeout'
            : status === 'skipped'
              ? 'no_device'
              : null;
      await client.query(
        `insert into public.notification_deliveries
           (outbox_id, incident_id, recipient_user_id, channel, device_id, status, error_code,
            sent_at, final_at)
         values ($1, $2, $3, $4, null, $5, $6,
                 case when $5 in ('sent','delivered') then $7::timestamptz end,
                 case when $5 <> 'queued' then $7::timestamptz end)`,
        [
          outboxId,
          incidentId,
          member,
          options.channel ?? 'push',
          status,
          error,
          options.at ?? '2026-11-25T10:00:00+00:00',
        ],
      );
    }

    async function status(member: string): Promise<MemberDelivery> {
      const db = app.get(DatabaseService).db;
      return db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        const result = await tx.execute<{ d: MemberDelivery }>(
          sql`select ${memberDeliverySql(sql`${incidentId}::uuid`, sql`${member}::uuid`)} as d`,
        );
        return result.rows[0].d;
      });
    }

    it('every case of D73', async () => {
      const [
        noRow,
        pending,
        retrying,
        failedOnly,
        skippedOnly,
        oneAccepted,
        recovers,
        otherTopics,
        sms,
      ] = Array.from({ length: 9 }, () => randomUUID());
      const created = await outbox('incident.created', [
        retrying,
        failedOnly,
        skippedOnly,
        oneAccepted,
        recovers,
        otherTopics,
        sms,
      ]);
      // A second alert notice already fanned out (one push row per member and notice).
      const second = await outbox('incident.renotified', [retrying, failedOnly, oneAccepted]);
      await row(created, retrying, 'queued', { error: 'timeout' });
      await row(second, retrying, 'failed', { at: '2026-11-25T10:00:01+00:00' });
      await row(created, failedOnly, 'failed', { at: '2026-11-25T10:00:02+00:00' });
      await row(second, failedOnly, 'skipped', { at: '2026-11-25T10:00:09+00:00' });
      await row(created, skippedOnly, 'skipped', { error: 'channel_disabled' });
      await row(created, oneAccepted, 'failed', { at: '2026-11-25T10:00:00+00:00' });
      await row(second, oneAccepted, 'sent', { at: '2026-11-25T10:00:03+00:00' });
      await row(created, recovers, 'failed', { at: '2026-11-25T10:00:04+00:00' });
      await row(created, otherTopics, 'failed', { at: '2026-11-25T10:00:05+00:00' });
      await row(created, sms, 'failed', { at: '2026-11-25T10:00:06+00:00' });
      await row(created, sms, 'sent', { channel: 'sms' });
      const update = await outbox('incident.status_update', [otherTopics]);
      await row(update, otherTopics, 'sent');
      const notice = await outbox('incident.delivery_failed', [otherTopics]);
      await row(notice, otherTopics, 'sent');
      // A re-notify naming `pending` and `recovers` that the worker has not fanned out yet.
      const renotified = await outbox('incident.renotified', [pending, recovers]);

      const failed = (at: string | null, reason: string) => ({
        delivery_status: 'failed',
        delivery_at: at,
        delivery_failed_reason: reason,
      });
      const sent = { delivery_status: 'sent', delivery_at: null, delivery_failed_reason: null };
      expect(await status(noRow)).toEqual(failed(null, 'no_device'));
      expect(await status(pending)).toEqual(sent);
      expect(await status(retrying)).toEqual(sent);
      expect(await status(failedOnly)).toEqual(failed('2026-11-25T10:00:09+00:00', 'failed'));
      expect(await status(skippedOnly)).toEqual(failed('2026-11-25T10:00:00+00:00', 'no_device'));
      expect(await status(oneAccepted)).toEqual({
        delivery_status: 'delivered',
        delivery_at: '2026-11-25T10:00:03+00:00',
        delivery_failed_reason: null,
      });
      expect(await status(recovers)).toEqual(sent);
      expect(await status(otherTopics)).toEqual(failed('2026-11-25T10:00:05+00:00', 'failed'));
      expect(await status(sms)).toEqual(failed('2026-11-25T10:00:06+00:00', 'failed'));

      // The re-notify is fanned out: `recovers` accepted -> delivered; `pending` failed.
      await row(renotified, recovers, 'sent', { at: '2026-11-25T10:01:00+00:00' });
      await row(renotified, pending, 'skipped', { at: '2026-11-25T10:01:01+00:00' });
      expect(await status(recovers)).toMatchObject({
        delivery_status: 'delivered',
        delivery_at: '2026-11-25T10:01:00+00:00',
      });
      expect(await status(pending)).toEqual(failed('2026-11-25T10:01:01+00:00', 'no_device'));
    });

    it('migration 0022: final_at is required on final rows and filled by the trigger when missing', async () => {
      const id = await outbox('incident.created', []);
      const member = randomUUID();
      await client.query(
        `insert into public.notification_deliveries
           (outbox_id, incident_id, recipient_user_id, channel, status, error_code)
         values ($1, $2, $3, 'push', 'skipped', 'no_device')`,
        [id, incidentId, member],
      );
      const [filled] = await query<{ ok: boolean }>(
        `select final_at is not null as ok from public.notification_deliveries
          where outbox_id = $1 and recipient_user_id = $2`,
        [id, member],
      );
      expect(filled.ok).toBe(true);
      await expect(
        client.query(
          `update public.notification_deliveries set status = 'queued'
            where outbox_id = $1 and recipient_user_id = $2`,
          [id, member],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'notification_deliveries_final_at_shape',
      });
    });
  });
});
