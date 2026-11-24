import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { Client } from 'pg';

import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import {
  FAKE_UNREGISTERED_TOKEN_PREFIX,
  type FakePushSender,
} from '../../src/modules/notifications/channels/fake-senders';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { createTestWorker } from '../../src/testing/test-worker';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import { fakePushToken, registerDevice } from '../support/device-api';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  inviteMember,
  type UserFixture,
} from '../support/fixtures';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * SCRUM-35 (Send a Test Safety Circle Alert), decisions D66-D68: the owner sends a test alert to
 * the ACTIVE members only (no active member → 409, nothing stored); Idempotency-Key; the per-owner
 * rate limit (429 with the wait time); push rows on the fake adapter with the exact title, body
 * and data; `circle.test_alert` to the recipients' user rooms only; the owner's status (pending →
 * delivered / failed → seen); the member's read and idempotent seen (404 for anyone else); and no
 * incident, incident event or responder row is ever created.
 */
type Body = Record<string, unknown>;
const CONFIG = { CHANNEL_PUSH_ENABLED: 'true' };
const TITLE = 'TEST ALERT — NOT AN EMERGENCY';

describe('SCRUM-35 test alerts (D66-D68)', () => {
  let app: NestFastifyApplication;
  let url: string;
  let worker: TestingModule;
  let client: Client;
  const open: TestSocket[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    ({ worker } = await createTestWorker(withTestConfig(CONFIG)));
    client = await openTestClient();
    await eventually(() => app.get(RealtimeGateway).ping());
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client.end();
    await worker.close();
    await app.close();
  });

  const push = () => worker.get(ChannelSenders).push as FakePushSender;

  async function send(userId: string, key: string = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: '/v1/me/circle/test-alerts',
      headers: { ...(await authHeader(userId)), 'idempotency-key': key },
    });
  }

  async function get(userId: string, path: string) {
    return app.inject({ method: 'GET', url: path, headers: await authHeader(userId) });
  }

  async function seen(userId: string, id: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/test-alerts/${id}/seen`,
      headers: await authHeader(userId),
    });
  }

  async function device(user: UserFixture, token: string): Promise<void> {
    const reply = await registerDevice(app, user.id, randomUUID(), {
      platform: 'android',
      app_version: '1.0.0',
      push_provider: 'fcm',
      push_token: token,
    });
    expect(reply.statusCode).toBe(200);
  }

  async function connect(user: UserFixture): Promise<TestSocket> {
    const socket = await connectSocket(url, user.id);
    open.push(socket);
    return socket;
  }

  async function incidentRowsOf(users: UserFixture[]): Promise<string> {
    const ids = users.map((u) => u.id);
    const { rows } = await client.query<{ counts: string }>(
      `select (select count(*) from public.incidents where resident_id = any($1::uuid[]))
              || '|' || (select count(*) from public.incident_events e
                           join public.incidents i on i.id = e.incident_id
                          where i.resident_id = any($1::uuid[]))
              || '|' || (select count(*) from public.incident_deliveries
                          where member_user_id = any($1::uuid[]))
              || '|' || (select count(*) from public.notification_deliveries
                          where recipient_user_id = any($1::uuid[]) and incident_id is not null)
              as counts`,
      [ids],
    );
    return rows[0].counts;
  }

  interface Scene {
    owner: UserFixture;
    circle: CircleFixture;
    reachable: UserFixture;
    unreachable: UserFixture;
    noDevice: UserFixture;
    pending: UserFixture;
    removed: UserFixture;
    outsider: UserFixture;
  }

  async function scene(): Promise<Scene> {
    const owner = await createUser(client, { fullName: '  Rita Owner ' });
    const circle = await createCircle(client, owner);
    const reachable = await createUser(client, { fullName: 'Milo Member' });
    const unreachable = await createUser(client, { fullName: 'Ana Member' });
    const noDevice = await createUser(client, { fullName: 'Zed Member' });
    const pending = await createUser(client);
    const removed = await createUser(client);
    const outsider = await createUser(client);
    await addActiveMember(client, circle, reachable);
    await addActiveMember(client, circle, unreachable);
    await addActiveMember(client, circle, noDevice);
    await inviteMember(client, circle, { claimedBy: pending });
    const removedRow = await addActiveMember(client, circle, removed);
    await client.query(
      `update public.safety_circle_members set status = 'removed', ended_at = now(),
              invite_token = null where id = $1`,
      [removedRow.id],
    );
    await device(reachable, fakePushToken('reach'));
    await device(unreachable, `${FAKE_UNREGISTERED_TOKEN_PREFIX}${randomUUID()}`);
    // Pending and removed members with devices: they must still get nothing.
    await device(pending, fakePushToken('pending'));
    await device(removed, fakePushToken('removed'));
    return { owner, circle, reachable, unreachable, noDevice, pending, removed, outsider };
  }

  it('no circle, or no active member (pending only) → 409 no_eligible_recipients; nothing stored', async () => {
    const lonely = await createUser(client);
    const noCircle = await send(lonely.id);
    expect(noCircle.statusCode).toBe(409);
    expect(noCircle.json<{ error: Body }>().error.code).toBe('test_alerts:no_eligible_recipients');

    const owner = await createUser(client);
    const circle = await createCircle(client, owner);
    const pending = await createUser(client);
    await inviteMember(client, circle, { claimedBy: pending });
    const reply = await send(owner.id);
    expect(reply.statusCode).toBe(409);
    expect(reply.json<{ error: Body }>().error).toMatchObject({
      code: 'test_alerts:no_eligible_recipients',
      message: 'Add an active member to send a test alert.',
    });
    const { rows } = await client.query<{ n: string }>(
      `select (select count(*) from public.circle_test_alerts where owner_id = any($1::uuid[]))
              + (select count(*) from public.notification_outbox
                  where topic = 'circle.test_alert' and payload->>'circle_id' = $2) as n`,
      [[lonely.id, owner.id], circle.id],
    );
    expect(rows[0].n).toBe('0');
    expect((await get(owner.id, '/v1/me/circle/test-alerts/latest')).json()).toEqual({
      test_alert: null,
    });
  });

  it('Idempotency-Key is required; not a UUID → 422', async () => {
    const s = await scene();
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/me/circle/test-alerts',
      headers: await authHeader(s.owner.id),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: Body }>().error.code).toBe('idempotency:key_required');
    const bad = await send(s.owner.id, 'not-a-uuid');
    expect(bad.statusCode).toBe(422);
  });

  it('send → active members only: push rows, socket event, status, member read and seen; no incident', async () => {
    const s = await scene();
    const sockets = {
      owner: await connect(s.owner),
      reachable: await connect(s.reachable),
      unreachable: await connect(s.unreachable),
      pending: await connect(s.pending),
      removed: await connect(s.removed),
      outsider: await connect(s.outsider),
    };
    const key = randomUUID();
    const reply = await send(s.owner.id, key);
    expect(reply.statusCode).toBe(201);
    const sent = reply.json<Body>();
    expect(Object.keys(sent)).toEqual(['id', 'created_at', 'recipient_count']);
    expect(sent.recipient_count).toBe(3);
    expect(sent.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/);
    const id = sent.id as string;

    // Idempotent replay: the same response, the handler did not run again.
    const replay = await send(s.owner.id, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(sent);
    const { rows: stored } = await client.query<{ n: string }>(
      'select count(*) as n from public.circle_test_alerts where owner_id = $1',
      [s.owner.id],
    );
    expect(stored[0].n).toBe('1');

    // Receipts = the three active members; the outbox row; the audit row.
    const { rows: receipts } = await client.query<{ member_user_id: string }>(
      'select member_user_id from public.circle_test_alert_receipts where test_alert_id = $1',
      [id],
    );
    expect(receipts.map((r) => r.member_user_id).sort()).toEqual(
      [s.reachable.id, s.unreachable.id, s.noDevice.id].sort(),
    );
    const { rows: outbox } = await client.query<{ topic: string; payload: Body }>(
      'select topic, payload from public.notification_outbox where aggregate_id = $1',
      [id],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0].topic).toBe('circle.test_alert');
    expect(outbox[0].payload).toEqual({
      test_alert_id: id,
      circle_id: s.circle.id,
      owner_name: 'Rita Owner',
      occurred_at: sent.created_at,
      recipient_user_ids: [s.reachable.id, s.unreachable.id, s.noDevice.id].sort(),
    });
    const { rows: audit } = await client.query<{ actor_user_id: string; detail: Body }>(
      `select actor_user_id, detail from public.audit_log
        where action = 'circle.test_alert.sent' and target_id = $1`,
      [id],
    );
    expect(audit).toEqual([
      { actor_user_id: s.owner.id, detail: { circle_id: s.circle.id, recipient_count: 3 } },
    ]);

    // Socket: circle.test_alert to the recipients' user rooms only.
    const event = await sockets.reachable.next<Body>('circle.test_alert');
    expect(event).toEqual({
      test_alert_id: id,
      owner_name: 'Rita Owner',
      created_at: sent.created_at,
      occurred_at: sent.created_at,
    });
    await expect(sockets.unreachable.next('circle.test_alert')).resolves.toEqual(event);
    await sleep(300);
    for (const socket of [sockets.owner, sockets.pending, sockets.removed, sockets.outsider]) {
      expect(socket.of('circle.test_alert')).toEqual([]);
    }

    // Worker: delivered to the reachable member, failed for the others.
    await eventually(async () => {
      const status = (await get(s.owner.id, `/v1/me/circle/test-alerts/${id}`)).json<Body>();
      expect(status.pending_count).toBe(0);
    }, 15_000);
    const { rows: deliveries } = await client.query<{
      recipient_user_id: string;
      incident_id: string | null;
      status: string;
      error_code: string | null;
      provider_message_id: string | null;
    }>(
      `select recipient_user_id, incident_id, status, error_code, provider_message_id
         from public.notification_deliveries where test_alert_id = $1`,
      [id],
    );
    expect(deliveries.map((d) => d.recipient_user_id).sort()).toEqual(
      [s.reachable.id, s.unreachable.id, s.noDevice.id].sort(),
    );
    expect(deliveries.every((d) => d.incident_id === null)).toBe(true);
    const ok = deliveries.find((d) => d.recipient_user_id === s.reachable.id)!;
    expect(ok.status).toBe('sent');
    const fake = push().sent.find((m) => m.provider_message_id === ok.provider_message_id);
    const { rows: hhmm } = await client.query<{ t: string }>(
      `select to_char(created_at at time zone 'Africa/Banjul', 'HH24:MI') as t
         from public.circle_test_alerts where id = $1`,
      [id],
    );
    expect(fake?.text).toEqual({
      title: TITLE,
      body: `Rita Owner is testing their Safety Circle · ${hhmm[0].t}`,
    });
    expect(fake?.content).toEqual({
      topic: 'circle.test_alert',
      test_alert_id: id,
      owner_name: 'Rita Owner',
      occurred_at: sent.created_at,
    });
    // Nobody outside the active members got a push of this test.
    const tokensPushed = push()
      .sent.filter((m) => (m.content as Body).test_alert_id === id)
      .map((m) => m.to.token);
    expect(tokensPushed).toHaveLength(1);

    const status = (await get(s.owner.id, `/v1/me/circle/test-alerts/${id}`)).json<Body>();
    expect(status).toMatchObject({
      id,
      circle_id: s.circle.id,
      created_at: sent.created_at,
      recipient_count: 3,
      delivered_count: 1,
      seen_count: 0,
      failed_count: 2,
      pending_count: 0,
    });
    const recipients = status.recipients as Body[];
    expect(recipients.map((r) => [r.display_name, r.status, r.failure_reason])).toEqual([
      ['Ana Member', 'failed', 'invalid_token'],
      ['Milo Member', 'delivered', null],
      ['Zed Member', 'failed', 'no_device'],
    ]);
    expect(Object.keys(recipients[0])).toEqual([
      'user_id',
      'display_name',
      'status',
      'failure_reason',
      'delivered_at',
      'seen_at',
    ]);
    expect(recipients[1].delivered_at).toEqual(expect.any(String));

    // Member read: the recipient only; everyone else 404.
    const read = await get(s.reachable.id, `/v1/test-alerts/${id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      id,
      owner_name: 'Rita Owner',
      created_at: sent.created_at,
      is_test: true,
      seen_at: null,
    });
    for (const other of [s.owner, s.pending, s.removed, s.outsider]) {
      const denied = await get(other.id, `/v1/test-alerts/${id}`);
      expect(denied.statusCode).toBe(404);
      expect(denied.json<{ error: Body }>().error.code).toBe('test_alerts:not_found');
      expect((await seen(other.id, id)).statusCode).toBe(404);
    }
    expect((await get(s.reachable.id, `/v1/test-alerts/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get(s.reachable.id, '/v1/test-alerts/nope')).statusCode).toBe(422);
    // The owner's status is the owner's only.
    expect((await get(s.reachable.id, `/v1/me/circle/test-alerts/${id}`)).statusCode).toBe(404);

    // Seen: set once, a repeat keeps the first time; the owner's counts move to seen.
    const first = await seen(s.reachable.id, id);
    expect(first.statusCode).toBe(200);
    const seenAt = first.json<Body>().seen_at;
    expect(seenAt).toEqual(expect.any(String));
    await sleep(20);
    expect((await seen(s.reachable.id, id)).json<Body>().seen_at).toBe(seenAt);
    // A failed push can still be seen in the app (in-app banner).
    expect((await seen(s.unreachable.id, id)).statusCode).toBe(200);
    const after = (await get(s.owner.id, '/v1/me/circle/test-alerts/latest')).json<{
      test_alert: Body;
    }>().test_alert;
    expect(after).toMatchObject({
      id,
      delivered_count: 0,
      seen_count: 2,
      failed_count: 1,
      pending_count: 0,
    });

    // A member removed after the send can no longer read it.
    await client.query(
      `update public.safety_circle_members set status = 'removed', ended_at = now(),
              invite_token = null where circle_id = $1 and user_id = $2`,
      [s.circle.id, s.noDevice.id],
    );
    expect((await get(s.noDevice.id, `/v1/test-alerts/${id}`)).statusCode).toBe(404);

    // Never an incident: no incident, incident event, responder row or incident push.
    expect(await incidentRowsOf([s.owner, s.reachable, s.unreachable, s.noDevice, s.pending])).toBe(
      '0|0|0|0',
    );
  }, 60_000);

  it('rate limit: a second test within 5 minutes → 429 with the wait time; 10 per 24 h', async () => {
    const s = await scene();
    expect((await send(s.owner.id)).statusCode).toBe(201);
    const again = await send(s.owner.id);
    expect(again.statusCode).toBe(429);
    const error = again.json<{ error: { code: string; details: Body } }>().error;
    expect(error.code).toBe('test_alerts:rate_limited');
    expect(error.details.reason).toBe('interval');
    const wait = error.details.retry_after_seconds as number;
    expect(wait).toBeGreaterThan(280);
    expect(wait).toBeLessThanOrEqual(300);
    expect(again.headers['retry-after']).toBe(String(wait));
    expect(error.details.next_allowed_at).toEqual(expect.any(String));

    // Ten tests in the last 24 hours (the latest 10 minutes ago): the daily limit.
    await client.query(
      `insert into public.circle_test_alerts (circle_id, owner_id, created_at, recipient_count)
       select $1, $2, now() - make_interval(mins => 10 + g * 60), 1 from generate_series(0, 8) g`,
      [s.circle.id, s.owner.id],
    );
    await client.query(
      `update public.circle_test_alerts set created_at = now() - interval '11 minutes'
        where owner_id = $1 and created_at > now() - interval '1 minute'`,
      [s.owner.id],
    );
    const daily = await send(s.owner.id);
    expect(daily.statusCode).toBe(429);
    const dailyError = daily.json<{ error: { details: Body } }>().error;
    expect(dailyError.details.reason).toBe('daily_limit');
    // The oldest of the ten is 8 h 10 min old: allowed again in about 15 h 50 min.
    const dailyWait = dailyError.details.retry_after_seconds as number;
    expect(dailyWait).toBeGreaterThan(15 * 3600);
    expect(dailyWait).toBeLessThanOrEqual(16 * 3600);
    const { rows } = await client.query<{ n: string }>(
      'select count(*) as n from public.circle_test_alerts where owner_id = $1',
      [s.owner.id],
    );
    expect(rows[0].n).toBe('10');
  });
});
