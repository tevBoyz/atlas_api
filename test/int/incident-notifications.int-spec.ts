import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { Client } from 'pg';

import { JobQueues } from '../../src/jobs/job-queues.service';
import { OUTBOX_QUEUE } from '../../src/jobs/jobs.constants';
import { OutboxRelay } from '../../src/jobs/outbox-relay.service';
import { AuditService } from '../../src/modules/audit';
import { INCIDENT_POST_COMMIT_HOOKS } from '../../src/modules/incidents/incident-post-commit';
import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import type { FakePushSender } from '../../src/modules/notifications/channels/fake-senders';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
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
import { markSafe, renotifyAlert, submitAlert, submitAlertViaSql } from '../support/incident-api';

/**
 * Incident notification wiring (API-100-48, D26): submit (created / promoted / renotified),
 * explicit re-notify and mark safe write their outbox row in their own transaction; the worker turns
 * it into delivery rows for the delivery-row recipients (created / renotified) or
 * `closure_notified.recipient_ids` (resolved), re-checked with `incident.memberView`; with the
 * channel disabled every row is `skipped`; preferences are recorded, not enforced (D4).
 */
type Body = Record<string, unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface OutboxDbRow {
  id: string;
  topic: string;
  aggregate_id: string;
  payload: Body;
  published_at: Date | null;
}

interface DeliveryDbRow {
  recipient_user_id: string;
  channel: string;
  device_id: string | null;
  status: string;
  error_code: string | null;
  preferences: Body;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

async function outboxOf(client: Client, incidentId: string): Promise<OutboxDbRow[]> {
  const { rows } = await client.query<OutboxDbRow>(
    `select id, topic, aggregate_id, payload, published_at
       from public.notification_outbox where aggregate_id = $1 order by created_at, id`,
    [incidentId],
  );
  return rows;
}

async function deliveriesOf(client: Client, outboxId: string): Promise<DeliveryDbRow[]> {
  const { rows } = await client.query<DeliveryDbRow>(
    `select recipient_user_id, channel, device_id, status, error_code, preferences
       from public.notification_deliveries where outbox_id = $1
      order by recipient_user_id, device_id nulls first`,
    [outboxId],
  );
  return rows;
}

async function settledDeliveries(
  client: Client,
  outboxId: string,
  expected: number,
): Promise<DeliveryDbRow[]> {
  let rows: DeliveryDbRow[] = [];
  await waitFor(async () => {
    rows = await deliveriesOf(client, outboxId);
    return rows.length === expected && rows.every((row) => row.status !== 'queued');
  });
  return rows;
}

/** A resident with a circle of `count` active members. */
async function circleWith(
  client: Client,
  count: number,
): Promise<{ resident: UserFixture; circle: CircleFixture; members: UserFixture[] }> {
  const resident = await createUser(client);
  const circle = await createCircle(client, resident);
  const members: UserFixture[] = [];
  for (let i = 0; i < count; i++) {
    const member = await createUser(client);
    await addActiveMember(client, circle, member);
    members.push(member);
  }
  return { resident, circle, members };
}

describe('incident notifications, channels disabled (the default) (API-100-48)', () => {
  let app: NestFastifyApplication;
  let worker: TestingModule;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    ({ worker } = await createTestWorker());
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

  it('created: one outbox row in the submit transaction, payload limited to the five values; every delivery skipped', async () => {
    const { resident, members } = await circleWith(client, 3);
    await registerDevice(app, members[0].id, randomUUID(), {
      platform: 'android',
      app_version: '1',
      push_provider: 'fcm',
      push_token: fakePushToken('m0a'),
    });
    await registerDevice(app, members[0].id, randomUUID(), {
      platform: 'ios',
      app_version: '1',
      push_provider: 'apns',
      push_token: fakePushToken('m0b'),
    });

    const reply = await submitAlert(app, resident.id, 'fire');
    expect(reply.statusCode).toBe(201);
    const incident = reply.json<Body>();
    const [row] = await outboxOf(client, incident.id as string);
    const { rows: times } = await client.query<{ sent_at: string }>(
      `select to_jsonb(sent_at) #>> '{}' as sent_at from public.incidents where id = $1`,
      [incident.id],
    );
    expect(row).toMatchObject({ topic: 'incident.created', aggregate_id: incident.id });
    expect(Object.keys(row.payload).sort()).toEqual([
      'emergency_type',
      'incident_id',
      'occurred_at',
      'recipient_user_ids',
      'resident_name',
    ]);
    expect(row.payload).toMatchObject({
      incident_id: incident.id,
      emergency_type: 'fire',
      resident_name: resident.fullName,
      recipient_user_ids: members.map((m) => m.id).sort(),
    });
    expect(new Date(row.payload.occurred_at as string).getTime()).toBe(
      new Date(times[0].sent_at).getTime(),
    );

    // Member 0: one row per device; members 1-2: one row each (no device). All skipped.
    const rows = await settledDeliveries(client, row.id, 4);
    expect(rows.map((r) => [r.channel, r.status, r.error_code])).toEqual(
      Array(4).fill(['push', 'skipped', 'channel_disabled']),
    );
    expect(rows.filter((r) => r.recipient_user_id === members[0].id)).toHaveLength(2);
    expect(rows.every((r) => r.recipient_user_id !== resident.id)).toBe(true);
    await waitFor(
      async () => (await outboxOf(client, incident.id as string))[0].published_at !== null,
    );
  });

  it('renotified (submit on an active alert and explicit re-notify), then resolved; a repeat mark safe adds nothing', async () => {
    const { resident, circle, members } = await circleWith(client, 2);
    const created = (await submitAlert(app, resident.id, 'medical')).json<Body>();
    const incidentId = created.id as string;
    // A member who joins after the alert started: never a recipient (rule 54, D14).
    const late = await createUser(client);
    await addActiveMember(client, circle, late);

    expect((await submitAlert(app, resident.id, 'medical')).statusCode).toBe(200);
    expect((await renotifyAlert(app, resident.id, incidentId)).statusCode).toBe(200);
    expect((await markSafe(app, resident.id, incidentId)).statusCode).toBe(200);
    expect((await markSafe(app, resident.id, incidentId)).statusCode).toBe(200);

    const rows = await outboxOf(client, incidentId);
    expect(rows.map((r) => r.topic)).toEqual([
      'incident.created',
      'incident.renotified',
      'incident.renotified',
      'incident.resolved',
    ]);
    const expected = members.map((m) => m.id).sort();
    for (const row of rows) expect(row.payload.recipient_user_ids).toEqual(expected);

    const { rows: incident } = await client.query<{
      renotified_at: string;
      resolved_at: string;
    }>(
      `select to_jsonb(renotified_at) #>> '{}' as renotified_at,
              to_jsonb(resolved_at) #>> '{}' as resolved_at
         from public.incidents where id = $1`,
      [incidentId],
    );
    expect(new Date(rows[2].payload.occurred_at as string).getTime()).toBe(
      new Date(incident[0].renotified_at).getTime(),
    );
    expect(new Date(rows[3].payload.occurred_at as string).getTime()).toBe(
      new Date(incident[0].resolved_at).getTime(),
    );
    // resolved = closure_notified.recipient_ids exactly.
    const { rows: closure } = await client.query<{ ids: string[] }>(
      `select detail -> 'recipient_ids' as ids from public.incident_events
        where incident_id = $1 and event_type = 'closure_notified'`,
      [incidentId],
    );
    expect(rows[3].payload.recipient_user_ids).toEqual(closure[0].ids);
    expect(closure[0].ids).not.toContain(late.id);

    for (const row of rows) {
      const deliveries = await settledDeliveries(client, row.id, 2);
      expect(deliveries.map((d) => d.status)).toEqual(['skipped', 'skipped']);
    }
  });

  it('promoted (legacy activating row) raises incident.created', async () => {
    const { resident } = await circleWith(client, 1);
    const { rows } = await client.query<{ id: string }>(
      `insert into public.incidents (resident_id, circle_id, status, activated_at)
       select $1, sc.id, 'activating', now() - interval '1 minute'
         from public.safety_circles sc where sc.owner_id = $1
       returning id`,
      [resident.id],
    );
    const reply = await submitAlert(app, resident.id, 'burglary');
    expect(reply.json<Body>().submit_outcome).toBe('promoted');
    expect((await outboxOf(client, rows[0].id)).map((r) => r.topic)).toEqual(['incident.created']);
  });

  it('a resident without members still gets a row (no recipients, no deliveries)', async () => {
    const resident = await createUser(client);
    await createCircle(client, resident);
    const incident = (await submitAlert(app, resident.id, 'other')).json<Body>();
    const [row] = await outboxOf(client, incident.id as string);
    expect(row.payload.recipient_user_ids).toEqual([]);
    await waitFor(
      async () => (await outboxOf(client, incident.id as string))[0].published_at !== null,
    );
    await sleep(300);
    expect(await deliveriesOf(client, row.id)).toEqual([]);
  });

  it('a submit whose transaction fails after the outbox insert leaves no outbox row and no job', async () => {
    const { resident } = await circleWith(client, 1);
    const queue = app.get(JobQueues).queue(OUTBOX_QUEUE);
    const { rows: before } = await client.query<{ n: number }>(
      'select count(*)::int as n from public.notification_outbox',
    );
    const jobsBefore = await queue.count();
    const audit = app.get(AuditService);
    const record = audit.record.bind(audit);
    jest
      .spyOn(audit, 'record')
      .mockImplementation((entry, tx) =>
        entry.action === 'incident.created'
          ? Promise.reject(new Error('audit down'))
          : record(entry, tx),
      );
    const reply = await submitAlert(app, resident.id, 'medical');
    expect(reply.statusCode).toBe(500);
    const { rows: incidents } = await client.query(
      'select 1 from public.incidents where resident_id = $1',
      [resident.id],
    );
    expect(incidents).toEqual([]);
    const { rows: after } = await client.query<{ n: number }>(
      'select count(*)::int as n from public.notification_outbox',
    );
    expect(after[0].n).toBe(before[0].n);
    await app.get(OutboxRelay).flush();
    expect(await queue.count()).toBeLessThanOrEqual(jobsBefore);
  });

  it('the SQL function path (today’s app) writes no outbox row: only API writes notify', async () => {
    const { resident } = await circleWith(client, 1);
    const result = await submitAlertViaSql(client, resident.id, 'medical');
    expect(typeof result.id).toBe('string');
    expect(await outboxOf(client, result.id as string)).toEqual([]);
  });
});

describe('incident notifications, push enabled on the fake adapter (API-100-48)', () => {
  const CONFIG = { CHANNEL_PUSH_ENABLED: 'true', OUTBOX_RELAY_INTERVAL_MS: '60000' };
  let app: NestFastifyApplication;
  let worker: TestingModule;
  let client: Client;

  beforeAll(async () => {
    // No post-commit kick: each test publishes explicitly, so it can change state in between.
    ({ app } = await createTestApp({}, (builder) =>
      withTestConfig(CONFIG)(builder).overrideProvider(INCIDENT_POST_COMMIT_HOOKS).useValue([]),
    ));
    ({ worker } = await createTestWorker(withTestConfig(CONFIG)));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await worker.close();
    await app.close();
  });

  const push = () => worker.get(ChannelSenders).push as FakePushSender;

  it('preferences are recorded but not enforced for an SOS (D4): push off still sends', async () => {
    const { resident, members } = await circleWith(client, 1);
    const token = fakePushToken('prefs');
    await registerDevice(app, members[0].id, randomUUID(), {
      platform: 'android',
      app_version: '1',
      push_provider: 'fcm',
      push_token: token,
    });
    await client.query('update public.profiles set alert_push_enabled = false where id = $1', [
      members[0].id,
    ]);
    const incident = (await submitAlert(app, resident.id, 'medical')).json<Body>();
    await app.get(OutboxRelay).flush();
    const [row] = await outboxOf(client, incident.id as string);
    const [delivery] = await settledDeliveries(client, row.id, 1);
    expect(delivery).toMatchObject({ status: 'sent', error_code: null });
    expect(delivery.preferences).toMatchObject({ alert_push_enabled: false });
    expect(push().sent.some((s) => s.to.token === token)).toBe(true);
  });

  it('a member removed between the submit and the fan-out is skipped not_eligible (memberView)', async () => {
    const { resident, circle, members } = await circleWith(client, 2);
    for (const member of members) {
      await registerDevice(app, member.id, randomUUID(), {
        platform: 'android',
        app_version: '1',
        push_provider: 'fcm',
        push_token: fakePushToken('rm'),
      });
    }
    const incident = (await submitAlert(app, resident.id, 'medical')).json<Body>();
    await client.query(
      'delete from public.safety_circle_members where circle_id = $1 and user_id = $2',
      [circle.id, members[1].id],
    );
    await app.get(OutboxRelay).flush();
    const [row] = await outboxOf(client, incident.id as string);
    const rows = await settledDeliveries(client, row.id, 2);
    const byUser = Object.fromEntries(rows.map((r) => [r.recipient_user_id, r]));
    expect(byUser[members[0].id]).toMatchObject({ status: 'sent' });
    expect(byUser[members[1].id]).toMatchObject({
      status: 'skipped',
      error_code: 'not_eligible',
      device_id: null,
    });
  });
});
