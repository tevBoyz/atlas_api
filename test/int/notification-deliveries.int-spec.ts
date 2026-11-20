import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type { Client } from 'pg';

import { DatabaseService } from '../../src/db/database.service';
import { OUTBOX_TOPIC_HANDLERS, type OutboxTopicHandler } from '../../src/jobs/job-workers';
import { OutboxWriter } from '../../src/jobs/outbox';
import { OutboxRelay } from '../../src/jobs/outbox-relay.service';
import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import type { Channel } from '../../src/modules/notifications/channels/channel.types';
import {
  FAKE_FAIL_TOKEN_PREFIX,
  FAKE_UNREGISTERED_TOKEN_PREFIX,
  FakePushSender,
} from '../../src/modules/notifications/channels/fake-senders';
import type { DeliveryRecipient } from '../../src/modules/notifications/deliveries.repository';
import { DeliveryPlanner } from '../../src/modules/notifications/deliveries.service';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { createTestWorker } from '../../src/testing/test-worker';
import { openTestClient } from '../support/database';
import { fakePushToken, registerDevice } from '../support/device-api';
import { createUser, type UserFixture } from '../support/fixtures';

/**
 * Delivery records and retries (API-100-47, D25): one row per recipient x channel x device with its
 * outcome; skipped rows for disabled channels, missing devices or addresses and ineligible
 * recipients; idempotent fan-out; retries with exponential backoff then `failed`; unregistered push
 * tokens cleared; nothing secret in the logs. Every channel uses the fake adapter.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_DELAY_MS = 50;
const CONFIG = {
  OUTBOX_RELAY_INTERVAL_MS: '60000',
  NOTIFICATIONS_RETRY_BASE_DELAY_MS: String(BASE_DELAY_MS),
  CHANNEL_PUSH_ENABLED: 'true',
  CHANNEL_SMS_ENABLED: 'true',
  CHANNEL_EMAIL_ENABLED: 'true',
};

interface DeliveryRow {
  id: string;
  recipient_user_id: string;
  channel: Channel;
  device_id: string | null;
  status: string;
  error_code: string | null;
  attempts: number;
  provider_message_id: string | null;
  preferences: Record<string, unknown>;
  sent_at: Date | null;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

describe('notification deliveries and retries (API-100-47)', () => {
  let app: NestFastifyApplication;
  let worker: TestingModule;
  let workerLogs: LogCapture;
  let client: Client;
  const secrets: string[] = [];

  /** The test topic handler: recipients and channels come from the payload. */
  const handler: OutboxTopicHandler = {
    topics: ['incident.created'],
    async handle(row) {
      const payload = row.payload as {
        recipients: DeliveryRecipient[];
        channels: Channel[];
        incident_id: string;
      };
      await worker
        .get(DeliveryPlanner)
        .fanOut(row, payload.incident_id, payload.recipients, payload.channels);
    },
  };

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    ({ worker, logs: workerLogs } = await createTestWorker((builder) =>
      withTestConfig(CONFIG)(builder).overrideProvider(OUTBOX_TOPIC_HANDLERS).useValue([handler]),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await worker.close();
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const push = () => worker.get(ChannelSenders).push as FakePushSender;

  async function device(user: UserFixture, token: string): Promise<string> {
    secrets.push(token);
    const reply = await registerDevice(app, user.id, randomUUID(), {
      platform: 'android',
      app_version: '1.0.0',
      push_provider: 'fcm',
      push_token: token,
    });
    expect(reply.statusCode).toBe(200);
    return reply.json<{ device_id: string }>().device_id;
  }

  /** Commits an outbox row and publishes it; returns its id. */
  async function notify(
    recipients: DeliveryRecipient[],
    channels: Channel[] = ['push', 'sms', 'email'],
  ): Promise<string> {
    const incidentId = randomUUID();
    const id = await app.get(DatabaseService).db.transaction((tx) =>
      app.get(OutboxWriter).insert(tx, {
        topic: 'incident.created',
        aggregateId: incidentId,
        payload: sql`${JSON.stringify({
          incident_id: incidentId,
          emergency_type: 'medical',
          resident_name: 'Resident Example',
          occurred_at: '2026-11-20T10:00:00+00:00',
          recipients,
          channels,
        })}::jsonb`,
      }),
    );
    await app.get(OutboxRelay).flush();
    return id;
  }

  async function deliveriesOf(outboxId: string): Promise<DeliveryRow[]> {
    const { rows } = await client.query<DeliveryRow>(
      `select id, recipient_user_id, channel, device_id, status, error_code, attempts,
              provider_message_id, preferences, sent_at
         from public.notification_deliveries
        where outbox_id = $1
        order by recipient_user_id, channel, device_id nulls first`,
      [outboxId],
    );
    return rows;
  }

  async function settled(outboxId: string, expected: number): Promise<DeliveryRow[]> {
    let rows: DeliveryRow[] = [];
    await waitFor(async () => {
      rows = await deliveriesOf(outboxId);
      return rows.length === expected && rows.every((row) => row.status !== 'queued');
    });
    return rows;
  }

  it('one row per recipient x channel x device; sent through the fakes with the five allowed values', async () => {
    const withDevices = await createUser(client, { phone: true });
    const noDevice = await createUser(client);
    const deviceA = await device(withDevices, fakePushToken('a'));
    const deviceB = await device(withDevices, fakePushToken('b'));
    // The member switched push alerts off: recorded, but an SOS still goes through (D4).
    await client.query(
      'update public.profiles set alert_push_enabled = false, alert_sms_enabled = false where id = $1',
      [withDevices.id],
    );
    const sentBefore = push().sent.length;

    const outboxId = await notify([
      { user_id: withDevices.id, eligible: true },
      { user_id: noDevice.id, eligible: true },
    ]);
    const rows = await settled(outboxId, 7);

    const of = (user: UserFixture, channel: Channel) =>
      rows.filter((row) => row.recipient_user_id === user.id && row.channel === channel);
    expect(
      of(withDevices, 'push')
        .map((row) => row.device_id)
        .sort(),
    ).toEqual([deviceA, deviceB].sort());
    for (const row of [...of(withDevices, 'push'), ...of(withDevices, 'sms')]) {
      expect(row).toMatchObject({ status: 'sent', attempts: 1, error_code: null });
      expect(row.provider_message_id).toMatch(/^fake-/);
      expect(row.sent_at).toBeInstanceOf(Date);
    }
    expect(of(withDevices, 'email')[0]).toMatchObject({ status: 'sent' });
    expect(of(noDevice, 'push')).toEqual([
      expect.objectContaining({ device_id: null, status: 'skipped', error_code: 'no_device' }),
    ]);
    expect(of(noDevice, 'sms')).toEqual([
      expect.objectContaining({ status: 'skipped', error_code: 'no_address', attempts: 0 }),
    ]);
    expect(of(noDevice, 'email')[0].status).toBe('sent');
    // Preferences are recorded on every row (not enforced for SOS, D4).
    for (const row of rows.filter((r) => r.recipient_user_id === withDevices.id)) {
      expect(row.preferences).toEqual({
        alert_push_enabled: false,
        alert_sms_enabled: false,
        alert_email_enabled: true,
      });
    }
    expect(of(noDevice, 'push')[0].preferences).toEqual({
      alert_push_enabled: true,
      alert_sms_enabled: true,
      alert_email_enabled: true,
    });

    const sent = push().sent.slice(sentBefore);
    expect(sent).toHaveLength(2);
    for (const message of sent) {
      expect(Object.keys(message.content as object).sort()).toEqual([
        'emergency_type',
        'incident_id',
        'occurred_at',
        'resident_name',
        'topic',
      ]);
    }
  });

  it('idempotent by outbox id: a second fan-out of the same row adds no row and sends nothing', async () => {
    const user = await createUser(client);
    await device(user, fakePushToken('idem'));
    const outboxId = await notify([{ user_id: user.id, eligible: true }], ['push']);
    const rows = await settled(outboxId, 1);
    const calls = push().calls.length;
    const { rows: outbox } = await client.query<{
      id: string;
      topic: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      created_at: string;
    }>(
      'select id, topic, aggregate_id, payload, created_at::text from public.notification_outbox where id = $1',
      [outboxId],
    );
    const queued = await worker
      .get(DeliveryPlanner)
      .fanOut(outbox[0], outbox[0].aggregate_id, [{ user_id: user.id, eligible: true }], ['push']);
    expect(queued).toBe(0);
    await sleep(300);
    expect(await deliveriesOf(outboxId)).toEqual(rows);
    expect(push().calls.length).toBe(calls);
  });

  it('a disabled channel records skipped rows and calls no adapter', async () => {
    const user = await createUser(client, { phone: true });
    await device(user, fakePushToken('off'));
    const channels = worker.get(ChannelSenders);
    const enabled = channels.isEnabled.bind(channels);
    jest
      .spyOn(channels, 'isEnabled')
      .mockImplementation((channel) => channel !== 'push' && enabled(channel));
    const calls = push().calls.length;
    const outboxId = await notify([{ user_id: user.id, eligible: true }], ['push', 'sms']);
    const rows = await settled(outboxId, 2);
    expect(rows.map((row) => [row.channel, row.status, row.error_code])).toEqual([
      ['push', 'skipped', 'channel_disabled'],
      ['sms', 'sent', null],
    ]);
    expect(push().calls.length).toBe(calls);
  });

  it('a recipient who is no longer eligible gets one skipped row per channel', async () => {
    const user = await createUser(client);
    await device(user, fakePushToken('gone'));
    const outboxId = await notify([{ user_id: user.id, eligible: false }]);
    const rows = await settled(outboxId, 3);
    expect(rows.map((row) => [row.channel, row.status, row.error_code])).toEqual([
      ['email', 'skipped', 'not_eligible'],
      ['push', 'skipped', 'not_eligible'],
      ['sms', 'skipped', 'not_eligible'],
    ]);
  });

  it('transient failures: 3 retries with exponential backoff, then failed with the error code (AC3)', async () => {
    const user = await createUser(client);
    const token = `${FAKE_FAIL_TOKEN_PREFIX}${randomUUID()}`;
    const deviceId = await device(user, token);
    const started = Date.now();
    const outboxId = await notify([{ user_id: user.id, eligible: true }], ['push']);
    const [row] = await settled(outboxId, 1);
    const elapsed = Date.now() - started;
    expect(row).toMatchObject({
      device_id: deviceId,
      status: 'failed',
      error_code: 'fake_unavailable',
      attempts: 4,
      sent_at: null,
    });
    expect(push().calls.filter((call) => call.token === token)).toHaveLength(4);
    // Backoff 50 + 100 + 200 ms before the three retries.
    expect(elapsed).toBeGreaterThanOrEqual(BASE_DELAY_MS * 7);
    await waitFor(() =>
      workerLogs.lines.some(
        (line) => line.job_id === row.id && line.msg === 'job failed, no retries left',
      ),
    );
    const failures = workerLogs.lines.filter((line) => line.job_id === row.id);
    expect(failures.map((line) => [line.msg, line.error_code])).toEqual([
      ['job failed, will retry', 'fake_unavailable'],
      ['job failed, will retry', 'fake_unavailable'],
      ['job failed, will retry', 'fake_unavailable'],
      ['job failed, no retries left', 'fake_unavailable'],
    ]);
    // A failed push keeps the token (only `unregistered` clears it).
    const { rows: devices } = await client.query<{ push_token: string | null }>(
      'select push_token from public.user_devices where id = $1',
      [deviceId],
    );
    expect(devices[0].push_token).toBe(token);
  });

  it('an unregistered token is cleared from user_devices and the row fails at once (AC4)', async () => {
    const user = await createUser(client);
    const token = `${FAKE_UNREGISTERED_TOKEN_PREFIX}${randomUUID()}`;
    const deviceId = await device(user, token);
    const outboxId = await notify([{ user_id: user.id, eligible: true }], ['push']);
    const [row] = await settled(outboxId, 1);
    expect(row).toMatchObject({ status: 'failed', error_code: 'unregistered', attempts: 1 });
    const { rows } = await client.query<{
      push_token: string | null;
      push_provider: string | null;
    }>('select push_token, push_provider from public.user_devices where id = $1', [deviceId]);
    expect(rows[0]).toEqual({ push_token: null, push_provider: null });
    expect(push().calls.filter((call) => call.token === token)).toHaveLength(1);
    await waitFor(() =>
      workerLogs.lines.some(
        (line) => line.job_id === row.id && line.msg === 'job failed, no retries left',
      ),
    );
  });

  it('no push token, phone number or email address appears in any worker log line', () => {
    expect(workerLogs.lines.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(workerLogs.text).not.toContain(secret);
    expect(workerLogs.text).not.toMatch(/@example\.test/);
    expect(workerLogs.text).not.toMatch(/\+1201555\d{4}/);
  });
});
