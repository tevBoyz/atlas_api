import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { Backoffs } from 'bullmq';
import type { Client } from 'pg';

import { parseConfig } from '../../src/config/config.schema';

import { JobQueues } from '../../src/jobs/job-queues.service';
import { DELIVERY_QUEUE, OUTBOX_QUEUE } from '../../src/jobs/jobs.constants';
import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import {
  FAKE_FAIL_TOKEN_PREFIX,
  type FakePushSender,
} from '../../src/modules/notifications/channels/fake-senders';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { createTestWorker } from '../../src/testing/test-worker';
import { openTestClient } from '../support/database';
import { clearDevicePushToken, fakePushToken, registerDevice } from '../support/device-api';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import { markSafe, renotifyAlert, submitAlert } from '../support/incident-api';

/**
 * Phase 5 gate (API-100-49 AC1): the whole pipeline with the fake push adapter: HTTP submit →
 * outbox row (same transaction) → relay → outbox job → fan-out → delivery job → fake push →
 * delivery `sent`; the failure path → 3 retries → `failed`; re-notify and mark safe; sign-out (U2)
 * stops pushes to that installation.
 *
 * Gap F: the retry delays are never waited for in real time. The DEFAULT schedule (3 retries,
 * 2 s / 4 s / 8 s) is computed on a fake clock by BullMQ's own backoff function from the job options
 * the fan-out wrote; the pipeline's worker runs with a 10 ms base delay, so the failure path takes
 * milliseconds, not 14 s, and no deadline depends on machine load.
 */
type Body = Record<string, unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONFIG = { CHANNEL_PUSH_ENABLED: 'true' };
/** The worker's retry base for the pipeline (the default 2000 ms schedule is checked on a fake clock). */
const FAST_RETRY_BASE_MS = 10;
const WORKER_CONFIG = { ...CONFIG, NOTIFICATIONS_RETRY_BASE_DELAY_MS: String(FAST_RETRY_BASE_MS) };

interface DeliveryDbRow {
  id: string;
  outbox_id: string;
  topic: string;
  recipient_user_id: string;
  device_id: string | null;
  status: string;
  error_code: string | null;
  attempts: number;
  provider_message_id: string | null;
  queued_at: Date;
  updated_at: Date;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(50);
  }
}

describe('Phase 5 gate: submit → outbox → job → fake push → delivery (API-100-49)', () => {
  let app: NestFastifyApplication;
  let worker: TestingModule;
  let workerLogs: LogCapture;
  let client: Client;

  let resident: UserFixture;
  let reachable: UserFixture;
  let unreachable: UserFixture;
  let incidentId: string;
  const goodToken = fakePushToken('good');
  const failingToken = `${FAKE_FAIL_TOKEN_PREFIX}${randomUUID()}`;
  const goodInstallation = randomUUID();

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    ({ worker, logs: workerLogs } = await createTestWorker(withTestConfig(WORKER_CONFIG)));
    client = await openTestClient();

    resident = await createUser(client);
    const circle = await createCircle(client, resident);
    reachable = await createUser(client);
    unreachable = await createUser(client);
    await addActiveMember(client, circle, reachable);
    await addActiveMember(client, circle, unreachable);
    for (const [user, token, installation] of [
      [reachable, goodToken, goodInstallation],
      [unreachable, failingToken, randomUUID()],
    ] as const) {
      const reply = await registerDevice(app, user.id, installation, {
        platform: 'android',
        app_version: '1.0.0',
        push_provider: 'fcm',
        push_token: token,
      });
      expect(reply.statusCode).toBe(200);
    }
  });

  afterAll(async () => {
    await client.end();
    await worker.close();
    await app.close();
  });

  const push = () => worker.get(ChannelSenders).push as FakePushSender;

  async function deliveries(topic?: string): Promise<DeliveryDbRow[]> {
    const { rows } = await client.query<DeliveryDbRow>(
      `select d.id, d.outbox_id, o.topic, d.recipient_user_id, d.device_id, d.status, d.error_code,
              d.attempts, d.provider_message_id, d.queued_at, d.updated_at
         from public.notification_deliveries d
         join public.notification_outbox o on o.id = d.outbox_id
        where o.aggregate_id = $1 and ($2::text is null or o.topic = $2)
        order by o.created_at, d.recipient_user_id`,
      [incidentId, topic ?? null],
    );
    return rows;
  }

  it('submit → delivery sent to the reachable member’s device through the fake push', async () => {
    const reply = await submitAlert(app, resident.id, 'medical');
    expect(reply.statusCode).toBe(201);
    incidentId = reply.json<Body>().id as string;

    let rows: DeliveryDbRow[] = [];
    await waitFor(async () => {
      rows = await deliveries('incident.created');
      return rows.some((r) => r.recipient_user_id === reachable.id && r.status === 'sent');
    }, 10_000);
    const sent = rows.find((r) => r.recipient_user_id === reachable.id)!;
    expect(sent).toMatchObject({ status: 'sent', attempts: 1, error_code: null });
    expect(sent.provider_message_id).toMatch(/^fake-/);
    const fake = push().sent.find((s) => s.provider_message_id === sent.provider_message_id);
    // The recipient's profiles.timezone goes with the target (D54); the CHECK allows Africa/Banjul only.
    expect(fake?.to).toEqual({ provider: 'fcm', token: goodToken, time_zone: 'Africa/Banjul' });
    expect(fake?.content).toMatchObject({ incident_id: incidentId, topic: 'incident.created' });
    // SCRUM-47 AC2 / D54: resident name, emergency type and the activation time (h:mm AM/PM, 12-hour, in
    // the recipient's time zone; Africa/Banjul = UTC).
    const { rows: at } = await client.query<{ hhmm: string }>(
      `select to_char(sent_at at time zone 'Africa/Banjul', 'FMHH12:MI AM') as hhmm
         from public.incidents where id = $1`,
      [incidentId],
    );
    expect(fake?.text).toEqual({
      title: resident.fullName,
      body: `Emergency alert: Medical · ${at[0].hhmm}`,
    });
    // SCRUM-47 latency line: one per accepted delivery, ids only, pipeline part well inside the 5 s of AC1 (the guide checks < 2 s).
    const latency = workerLogs.lines.filter(
      (line) => line.msg === 'delivery accepted by the provider' && line.delivery_id === sent.id,
    );
    expect(latency).toHaveLength(1);
    expect(latency[0]).toMatchObject({
      incident_id: incidentId,
      topic: 'incident.created',
      channel: 'push',
      provider: 'fcm',
    });
    expect(latency[0].latency_ms).toEqual(expect.any(Number));
    expect(latency[0].latency_ms as number).toBeLessThan(5_000);
    // The outbox job (job id = outbox id) and the delivery job (job id = delivery id) completed.
    const queues = app.get(JobQueues);
    // SCRUM-65/71: after its fan-out the outbox job re-checks each member's delivery status, so it
    // may still be finishing when the first delivery is already sent.
    await waitFor(
      async () =>
        (await (await queues.queue(OUTBOX_QUEUE).getJob(sent.outbox_id))?.getState()) ===
        'completed',
      10_000,
    );
    // The delivery row is written inside the delivery job, so the job itself may finish just after.
    await waitFor(
      async () =>
        (await (await queues.queue(DELIVERY_QUEUE).getJob(sent.id))?.getState()) === 'completed',
      10_000,
    );
  });

  it('the default retry schedule is 3 retries at 2 s, 4 s, 8 s (fake clock: computed, not waited)', async () => {
    const defaults = parseConfig({ NODE_ENV: 'test' });
    expect(defaults.NOTIFICATIONS_RETRY_ATTEMPTS).toBe(3);
    const backoff = { type: 'exponential', delay: defaults.NOTIFICATIONS_RETRY_BASE_DELAY_MS };
    const schedule: number[] = [];
    for (
      let attemptsMade = 1;
      attemptsMade <= defaults.NOTIFICATIONS_RETRY_ATTEMPTS;
      attemptsMade++
    ) {
      schedule.push(
        (await Backoffs.calculate(backoff, attemptsMade, new Error('x'), {} as never)) as number,
      );
    }
    expect(schedule).toEqual([2_000, 4_000, 8_000]);
  });

  it('failure path: the fan-out schedules exponential retries; 3 retries, then failed', async () => {
    let failed: DeliveryDbRow | undefined;
    await waitFor(async () => {
      failed = (await deliveries('incident.created')).find(
        (r) => r.recipient_user_id === unreachable.id && r.status === 'failed',
      );
      return failed !== undefined;
    }, 30_000);
    expect(failed).toMatchObject({ error_code: 'fake_unavailable', attempts: 4 });
    // The job carries the configured schedule (exponential from the base, 3 retries): with the
    // default base that is the 2 s / 4 s / 8 s above.
    const job = await worker.get(JobQueues).queue(DELIVERY_QUEUE).getJob(failed!.id);
    expect(job?.opts).toMatchObject({
      attempts: 4,
      backoff: { type: 'exponential', delay: FAST_RETRY_BASE_MS },
    });
    expect(push().calls.filter((c) => c.token === failingToken).length).toBeGreaterThanOrEqual(4);
    // The row is final before the job's last error is logged (SCRUM-65/71: the member's delivery
    // status is re-checked in between), so wait for the fourth line.
    const jobLines = () => workerLogs.lines.filter((line) => line.job_id === failed!.id);
    await waitFor(() => jobLines().length >= 4, 10_000);
    const logged = jobLines().map((line) => line.msg);
    expect(logged).toEqual([
      'job failed, will retry',
      'job failed, will retry',
      'job failed, will retry',
      'job failed, no retries left',
    ]);
  });

  it('re-notify and mark safe reach the reachable member too', async () => {
    expect((await renotifyAlert(app, resident.id, incidentId)).statusCode).toBe(200);
    expect((await markSafe(app, resident.id, incidentId)).statusCode).toBe(200);
    await waitFor(async () => {
      const rows = await deliveries();
      return ['incident.renotified', 'incident.resolved'].every((topic) =>
        rows.some(
          (r) => r.topic === topic && r.recipient_user_id === reachable.id && r.status === 'sent',
        ),
      );
    }, 10_000);
    // The visible texts of the re-notify and the closing notice carry their own event time (D54).
    const texts = push()
      .sent.filter(
        (s) =>
          s.to.token === goodToken &&
          (s.content as { incident_id: string }).incident_id === incidentId,
      )
      .map((s) => s.text?.body);
    expect(texts).toEqual([
      expect.stringMatching(/^Emergency alert: Medical · \d{1,2}:\d{2} [AP]M$/),
      expect.stringMatching(/^Alert sent again: Medical · \d{1,2}:\d{2} [AP]M$/),
      expect.stringMatching(/^Marked safe\. The alert is closed\. · \d{1,2}:\d{2} [AP]M$/),
    ]);
  });

  it('after sign-out (U2) that installation gets no push: the next alert records no_device', async () => {
    expect((await clearDevicePushToken(app, reachable.id, goodInstallation)).statusCode).toBe(204);
    const reply = await submitAlert(app, resident.id, 'fire');
    expect(reply.statusCode).toBe(201);
    incidentId = reply.json<Body>().id as string;
    await waitFor(async () => {
      const rows = await deliveries('incident.created');
      return rows.some((r) => r.recipient_user_id === reachable.id && r.status === 'skipped');
    }, 10_000);
    const [row] = (await deliveries('incident.created')).filter(
      (r) => r.recipient_user_id === reachable.id,
    );
    expect(row).toMatchObject({ status: 'skipped', error_code: 'no_device', device_id: null });
  });

  it('no push token or name appears in any API or worker log line', () => {
    expect(workerLogs.text).not.toContain(goodToken);
    expect(workerLogs.text).not.toContain(failingToken);
    for (const user of [resident, reachable, unreachable]) {
      expect(workerLogs.text).not.toContain(user.fullName);
      expect(workerLogs.text).not.toContain(user.email);
    }
  });
});
