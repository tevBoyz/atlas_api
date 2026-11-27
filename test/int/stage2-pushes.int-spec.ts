import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { Client } from 'pg';

import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import type { FakePushSender } from '../../src/modules/notifications/channels/fake-senders';
import { DeliveriesRepository } from '../../src/modules/notifications/deliveries.repository';
import { ReceiptTokens } from '../../src/modules/notifications/receipt-token';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { authHeader as authHeaderOf } from '../../src/testing/test-tokens';
import { createTestWorker } from '../../src/testing/test-worker';
import { openTestClient } from '../support/database';
import { fakePushToken, registerDevice } from '../support/device-api';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import { submitAlert } from '../support/incident-api';

/**
 * Gaps_Adressed Stage 2, the push side: [TZ] the receiving device's time zone (migration 0026
 * `user_devices.time_zone`; every push time in that zone, else the profile's, else Banjul).
 */
type Body = Record<string, unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONFIG = { CHANNEL_PUSH_ENABLED: 'true' };

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(50);
  }
}

describe('Stage 2 pushes', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let workerLogs: LogCapture;
  let worker: TestingModule;
  let client: Client;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({}, withTestConfig(CONFIG)));
    ({ worker, logs: workerLogs } = await createTestWorker(
      withTestConfig({ ...CONFIG, NOTIFICATIONS_RETRY_BASE_DELAY_MS: '10' }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await worker.close();
    await app.close();
  });

  const push = () => worker.get(ChannelSenders).push as FakePushSender;

  async function device(
    user: UserFixture,
    extra: Body = {},
    installation: string = randomUUID(),
  ): Promise<{ token: string; installation: string }> {
    const token = fakePushToken('s2');
    const reply = await registerDevice(app, user.id, installation, {
      platform: 'android',
      app_version: '1.0.0',
      push_provider: 'fcm',
      push_token: token,
      ...extra,
    });
    expect(reply.statusCode).toBe(200);
    return { token, installation };
  }

  async function zoneOf(installation: string): Promise<string | null> {
    const { rows } = await client.query<{ time_zone: string | null }>(
      'select time_zone from public.user_devices where installation_id = $1',
      [installation],
    );
    return rows[0].time_zone;
  }

  describe('[TZ] device time zone', () => {
    it('stored on registration; left out keeps it; unknown or null -> null, never an error', async () => {
      const user = await createUser(client);
      const { installation } = await device(user, { time_zone: 'Africa/Addis_Ababa' });
      expect(await zoneOf(installation)).toBe('Africa/Addis_Ababa');
      await device(user, {}, installation);
      expect(await zoneOf(installation)).toBe('Africa/Addis_Ababa');
      await device(user, { time_zone: 'Mars/Olympus' }, installation);
      expect(await zoneOf(installation)).toBeNull();
      await device(user, { time_zone: 'Asia/Tokyo' }, installation);
      await device(user, { time_zone: null }, installation);
      expect(await zoneOf(installation)).toBeNull();
    });

    it('each receiving device formats the push time in its own zone; no zone -> Banjul', async () => {
      const resident = await createUser(client);
      const circle = await createCircle(client, resident);
      const member = await createUser(client);
      await addActiveMember(client, circle, member);
      const addis = await device(member, { time_zone: 'Africa/Addis_Ababa' });
      const tokyo = await device(member, { time_zone: 'Asia/Tokyo' });
      const none = await device(member);

      const reply = await submitAlert(app, resident.id, 'medical');
      expect(reply.statusCode).toBe(201);
      const incidentId = reply.json<Body>().id as string;
      const sentTo = (token: string) =>
        push().sent.find(
          (s) =>
            s.to.token === token &&
            (s.content as { incident_id?: string }).incident_id === incidentId,
        );
      await waitFor(() => [addis, tokyo, none].every((d) => sentTo(d.token)));

      const at = Date.parse((sentTo(addis.token)?.content as { occurred_at: string }).occurred_at);
      const time = (zone: string) => {
        const parts = new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hourCycle: 'h12',
          timeZone: zone,
        }).formatToParts(at);
        const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
        return `${Number(part('hour')) % 12 || 12}:${part('minute')} ${part('dayPeriod').toUpperCase()}`;
      };
      expect(sentTo(addis.token)?.to.time_zone).toBe('Africa/Addis_Ababa');
      expect(sentTo(addis.token)?.text?.body).toContain(`· ${time('Africa/Addis_Ababa')}`);
      expect(sentTo(tokyo.token)?.text?.body).toContain(`· ${time('Asia/Tokyo')}`);
      // No device zone: the profile's (the CHECK allows Africa/Banjul only).
      expect(sentTo(none.token)?.to.time_zone).toBe('Africa/Banjul');
      expect(sentTo(none.token)?.text?.body).toContain(`· ${time('Africa/Banjul')}`);
    });
  });

  describe('[B6] place of the alert', () => {
    async function residentWithMember() {
      const resident = await createUser(client, { fullName: 'Rita Place' });
      const circle = await createCircle(client, resident);
      const member = await createUser(client);
      await addActiveMember(client, circle, member);
      const { token } = await device(member);
      return { resident, member, token };
    }

    const pushOf = (token: string, incidentId: string, topic: string) =>
      push().sent.find(
        (s) =>
          s.to.token === token &&
          (s.content as { incident_id?: string; topic?: string }).incident_id === incidentId &&
          (s.content as { topic?: string }).topic === topic,
      );

    it('submit with a place: stored (trimmed, country uppercase), on the JSON, the push says near it', async () => {
      const { resident, token } = await residentWithMember();
      const reply = await app.inject({
        method: 'POST',
        url: '/v1/incidents',
        headers: {
          ...(await authHeaderOf(resident.id)),
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          emergency_type: 'fire',
          place_name: '  Serrekunda ',
          country_code: 'gm',
        }),
      });
      expect(reply.statusCode).toBe(201);
      const body = reply.json<Body>();
      expect(body).toMatchObject({ place_name: 'Serrekunda', country_code: 'GM' });
      const incidentId = body.id as string;
      await waitFor(() => Boolean(pushOf(token, incidentId, 'incident.created')));
      const sent = pushOf(token, incidentId, 'incident.created')!;
      expect(sent.text?.body).toMatch(
        /^Emergency alert: Fire · near Serrekunda · \d{1,2}:\d{2} [AP]M$/,
      );
      // Text only: never a data key, never coordinates.
      expect(JSON.stringify(sent.content)).not.toContain('location_lat');
    });

    it('no place known at send time: "Location unavailable"; a place sent later is on the re-notify', async () => {
      const { resident, token } = await residentWithMember();
      const reply = await submitAlert(app, resident.id, 'medical');
      expect(reply.statusCode).toBe(201);
      const incidentId = reply.json<Body>().id as string;
      expect(reply.json<Body>()).toMatchObject({ place_name: null, country_code: null });
      await waitFor(() => Boolean(pushOf(token, incidentId, 'incident.created')));
      expect(pushOf(token, incidentId, 'incident.created')!.text?.body).toMatch(
        /^Emergency alert: Medical · Location unavailable · \d{1,2}:\d{2} [AP]M$/,
      );

      // The place comes with a location report: latest wins; an invalid value is ignored (no error).
      const located = await app.inject({
        method: 'POST',
        url: `/v1/incidents/${incidentId}/locations`,
        headers: { ...(await authHeaderOf(resident.id)), 'content-type': 'application/json' },
        payload: JSON.stringify({
          location_source: 'current',
          location_lat: 13.45,
          location_lng: -16.68,
          location_accuracy_m: 10,
          location_captured_at: new Date().toISOString(),
          place_name: 'Bakau',
          country_code: 'ET',
        }),
      });
      expect(located.statusCode).toBe(200);
      expect(located.json<Body>()).toMatchObject({ place_name: 'Bakau', country_code: 'ET' });
      const ignored = await app.inject({
        method: 'POST',
        url: `/v1/incidents/${incidentId}/locations`,
        headers: { ...(await authHeaderOf(resident.id)), 'content-type': 'application/json' },
        payload: JSON.stringify({
          location_source: 'unavailable',
          place_name: 'x'.repeat(121),
          country_code: 'Ethiopia',
        }),
      });
      expect(ignored.statusCode).toBe(200);
      expect(ignored.json<Body>()).toMatchObject({ place_name: 'Bakau', country_code: 'ET' });

      const again = await submitAlert(app, resident.id, 'medical');
      expect(again.statusCode).toBe(200);
      await waitFor(() => Boolean(pushOf(token, incidentId, 'incident.renotified')));
      expect(pushOf(token, incidentId, 'incident.renotified')!.text?.body).toMatch(
        /^Alert sent again: Medical · near Bakau · \d{1,2}:\d{2} [AP]M$/,
      );
    });
  });
  describe('[B7] Delivered = the phone confirmed receipt (D77)', () => {
    const receipt = (token: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/notifications/receipts',
        headers: { 'content-type': 'application/json', ...headers },
        payload: JSON.stringify({ receipt_token: token }),
      });

    async function deliveryRow(id: string) {
      const { rows } = await client.query<{
        status: string;
        delivered_at: Date | null;
        sent_at: Date | null;
      }>('select status, delivered_at, sent_at from public.notification_deliveries where id = $1', [
        id,
      ]);
      return rows[0];
    }

    async function outcomeAudits(incidentId: string): Promise<string[]> {
      const { rows } = await client.query<{ status: string }>(
        `select detail->>'status' as status from public.audit_log
          where target_id = $1 and action = 'incident.delivery_outcome' order by id`,
        [incidentId],
      );
      return rows.map((r) => r.status);
    }

    async function memberStatus(residentId: string, incidentId: string, memberId: string) {
      const reply = await app.inject({
        method: 'GET',
        url: `/v1/incidents/${incidentId}/responders`,
        headers: await authHeaderOf(residentId),
      });
      expect(reply.statusCode).toBe(200);
      return reply
        .json<Body[]>()
        .find((r) => (r.user_id ?? r.member_user_id) === memberId || r.is_me === false)
        ?.delivery_status;
    }

    it('accepted by the push service = sent; the receipt (no auth) makes it delivered, audited once', async () => {
      const resident = await createUser(client);
      const circle = await createCircle(client, resident);
      const member = await createUser(client);
      await addActiveMember(client, circle, member);
      const { token } = await device(member);

      const reply = await submitAlert(app, resident.id, 'medical');
      const incidentId = reply.json<Body>().id as string;
      let sent: FakePushSender['sent'][number] | undefined;
      await waitFor(() => {
        sent = push().sent.find(
          (s) =>
            s.to.token === token &&
            (s.content as { incident_id?: string }).incident_id === incidentId,
        );
        return Boolean(sent);
      });
      const receiptToken = sent!.to.receipt_token!;
      expect(receiptToken).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
      const { rows } = await client.query<{ id: string }>(
        `select id from public.notification_deliveries
          where incident_id = $1 and recipient_user_id = $2 and channel = 'push'`,
        [incidentId, member.id],
      );
      const deliveryId = rows[0].id;
      await waitFor(async () => (await deliveryRow(deliveryId)).status === 'sent');
      expect(await memberStatus(resident.id, incidentId, member.id)).toBe('sent');
      await waitFor(async () => (await outcomeAudits(incidentId)).length === 1);
      expect(await outcomeAudits(incidentId)).toEqual(['sent']);

      // No Authorization header: 204, the row is delivered, the resident sees Delivered.
      const first = await receipt(receiptToken);
      expect(first.statusCode).toBe(204);
      expect(first.body).toBe('');
      const row = await deliveryRow(deliveryId);
      expect(row.status).toBe('delivered');
      expect(row.delivered_at).not.toBeNull();
      expect(await memberStatus(resident.id, incidentId, member.id)).toBe('delivered');
      expect(await outcomeAudits(incidentId)).toEqual(['sent', 'delivered']);

      // A repeat: 204, no effect, no second audit row.
      expect((await receipt(receiptToken)).statusCode).toBe(204);
      expect((await deliveryRow(deliveryId)).delivered_at).toEqual(row.delivered_at);
      expect(await outcomeAudits(incidentId)).toEqual(['sent', 'delivered']);

      // The token never reaches a log line.
      expect(logs.text).not.toContain(receiptToken);
      expect(workerLogs.text).not.toContain(receiptToken);
    });

    it('forged, malformed or missing tokens: 204, nothing changes; a bearer header is not needed', async () => {
      const before = await client.query<{ n: string }>(
        `select count(*) as n from public.notification_deliveries where status = 'delivered'`,
      );
      const forged = `${randomUUID().replace(/-/g, '')}.AAAAAAAAAAAAAAAAAAAAAA`;
      for (const token of [forged, 'nonsense', '', null, 42]) {
        expect((await receipt(token)).statusCode).toBe(204);
      }
      const empty = await app.inject({
        method: 'POST',
        url: '/v1/notifications/receipts',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(empty.statusCode).toBe(204);
      const after = await client.query<{ n: string }>(
        `select count(*) as n from public.notification_deliveries where status = 'delivered'`,
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(logs.text).not.toContain(forged);
    });

    it('a receipt that arrives while the row is still queued: the sender writes delivered (one audit row)', async () => {
      const resident = await createUser(client);
      const circle = await createCircle(client, resident);
      const member = await createUser(client);
      await addActiveMember(client, circle, member);
      await device(member);
      // Crafted: the row exists queued (the provider's answer not written yet) and the phone reports.
      const outbox = await client.query<{ id: string }>(
        `insert into public.notification_outbox (topic, aggregate_id, payload)
         values ('incident.created', gen_random_uuid(), '{}'::jsonb) returning id`,
      );
      const queued = await client.query<{ id: string }>(
        `insert into public.notification_deliveries (outbox_id, recipient_user_id, channel, status)
         values ($1, $2, 'push', 'queued') returning id`,
        [outbox.rows[0].id, member.id],
      );
      const id = queued.rows[0].id;
      const tokens = worker.get(ReceiptTokens);
      expect((await receipt(tokens.sign(id))).statusCode).toBe(204);
      const pending = await deliveryRow(id);
      expect(pending.status).toBe('queued');
      expect(pending.delivered_at).not.toBeNull();
      await worker.get(DeliveriesRepository).markSent(id, 'sent', 'fake-x');
      expect((await deliveryRow(id)).status).toBe('delivered');
      await client.query('delete from public.notification_deliveries where id = $1', [id]);
      await client.query('delete from public.notification_outbox where id = $1', [
        outbox.rows[0].id,
      ]);
    });
  });
});
