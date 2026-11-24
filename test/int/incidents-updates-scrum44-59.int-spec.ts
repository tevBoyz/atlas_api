import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { Client } from 'pg';

import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import type { FakePushSender } from '../../src/modules/notifications/channels/fake-senders';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
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
  inviteMember,
  type UserFixture,
} from '../support/fixtures';
import { getIncidentEvents, markSafe, submitAlert } from '../support/incident-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * SCRUM-44 (Send Status Updates) + SCRUM-59 (Resident Status Updates, Broadcast), decision D70:
 * `POST /v1/incidents/{id}/updates` (resident only, active only, Idempotency-Key, body exactly one of
 * a preset or 1-250 characters of text, 10 per minute per alert) writes one `status_update` event,
 * one `incident.status_update` outbox row and one audit row without the text; `GET .../updates`
 * lists them newest first for the resident and the members inside the window (also once resolved or
 * closed); the incident room gets `incident.update`; the worker pushes it to the alert's recipients
 * on the emergency channel with the resident's name and the preset or the shortened text plus the
 * time. Mark safe and an update racing each other never leave an update after the alert ended.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<NestFastifyApplication['inject']>>;
const CONFIG = {
  CHANNEL_PUSH_ENABLED: 'true',
  RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
  RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
  DATABASE_POOL_MAX: '30',
};
const SECRET_TEXT = 'Kitchen door jammed, smoke in hallway SECRET-UPDATE-TEXT';

describe('SCRUM-44/59 resident status updates (D70)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let url: string;
  let worker: TestingModule;
  let workerLogs: LogCapture;
  let client: Client;
  const open: TestSocket[] = [];

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({}, withTestConfig(CONFIG)));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    ({ worker, logs: workerLogs } = await createTestWorker(withTestConfig(CONFIG)));
    client = await openTestClient();
    await eventually(() => app.get(RealtimeGateway).ping());
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client?.end();
    await worker?.close();
    await app?.close();
  });

  const push = () => worker.get(ChannelSenders).push as FakePushSender;

  async function send(
    userId: string,
    incidentId: string,
    body: unknown,
    key: string = randomUUID(),
  ) {
    return app.inject({
      method: 'POST',
      url: `/v1/incidents/${incidentId}/updates`,
      headers: {
        ...(await authHeader(userId)),
        'content-type': 'application/json',
        ...(key === '' ? {} : { 'idempotency-key': key }),
      },
      payload: JSON.stringify(body),
    });
  }

  async function list(userId: string, incidentId: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/incidents/${incidentId}/updates`,
      headers: await authHeader(userId),
    });
  }

  const errorOf = (reply: Reply) => reply.json<{ error: { code: string; details?: Body } }>().error;

  async function connect(user: UserFixture): Promise<TestSocket> {
    const socket = await connectSocket(url, user.id);
    open.push(socket);
    return socket;
  }

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    member: UserFixture;
    other: UserFixture;
    outsider: UserFixture;
    incidentId: string;
  }

  /** Tess (resident) with Milo and Ana (active members) and an outsider; Tess's alert is active. */
  async function scene(): Promise<Scene> {
    const resident = await createUser(client, { fullName: '  Tess Resident ' });
    const circle = await createCircle(client, resident);
    const member = await createUser(client, { fullName: 'Milo Member' });
    const other = await createUser(client, { fullName: 'Ana Member' });
    await addActiveMember(client, circle, member);
    await addActiveMember(client, circle, other);
    const outsider = await createUser(client);
    const reply = await submitAlert(app, resident.id, 'fire');
    expect(reply.statusCode).toBe(201);
    return {
      resident,
      circle,
      member,
      other,
      outsider,
      incidentId: reply.json<Body>().id as string,
    };
  }

  const eventRows = (incidentId: string) =>
    client
      .query<{ id: string; actor_id: string; detail: Body; occurred_at: string }>(
        `select id::text, actor_id::text, detail,
                (to_jsonb(occurred_at at time zone 'UTC') #>> '{}') || '+00:00' as occurred_at
           from public.incident_events
          where incident_id = $1 and event_type = 'status_update' order by occurred_at, id`,
        [incidentId],
      )
      .then((r) => r.rows);

  const outboxRows = (incidentId: string) =>
    client
      .query<{ id: string; payload: Body }>(
        `select id::text, payload from public.notification_outbox
          where aggregate_id = $1 and topic = 'incident.status_update' order by created_at, id`,
        [incidentId],
      )
      .then((r) => r.rows);

  const auditRows = (incidentId: string) =>
    client
      .query<{ actor_user_id: string; detail: Body }>(
        `select actor_user_id::text, detail from public.audit_log
          where target_id = $1 and action = 'incident.update_sent' order by id`,
        [incidentId],
      )
      .then((r) => r.rows);

  /** Nothing was written for this incident by a refused update. */
  async function nothingWritten(incidentId: string): Promise<void> {
    expect(await eventRows(incidentId)).toEqual([]);
    expect(await outboxRows(incidentId)).toEqual([]);
    expect(await auditRows(incidentId)).toEqual([]);
  }

  describe('migration 0020', () => {
    it('the event-type check allows status_update and still refuses unknown types', async () => {
      const s = await scene();
      await client.query(
        `insert into public.incident_events (incident_id, event_type, actor_id, detail)
         values ($1, 'status_update', $2, '{"preset": "help_is_here"}')`,
        [s.incidentId, s.resident.id],
      );
      await expect(
        client.query(
          `insert into public.incident_events (incident_id, event_type) values ($1, 'chat')`,
          [s.incidentId],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'incident_events_type_allowed' });
      // status_update may repeat (not in the once-per-incident index).
      await client.query(
        `insert into public.incident_events (incident_id, event_type, actor_id, detail)
         values ($1, 'status_update', $2, '{"preset": "help_is_here"}')`,
        [s.incidentId, s.resident.id],
      );
      expect(await eventRows(s.incidentId)).toHaveLength(2);
    });
  });

  describe('POST /v1/incidents/{id}/updates', () => {
    it('a preset: 201 {id, preset, text: null, created_at}; event, outbox row and audit row', async () => {
      const s = await scene();
      const reply = await send(s.resident.id, s.incidentId, { preset: 'situation_worsening' });
      expect(reply.statusCode).toBe(201);
      const body = reply.json<Body>();
      expect(Object.keys(body)).toEqual(['id', 'preset', 'text', 'created_at']);
      expect(body).toMatchObject({ preset: 'situation_worsening', text: null });

      const [event] = await eventRows(s.incidentId);
      expect(event).toEqual({
        id: body.id,
        actor_id: s.resident.id,
        detail: { preset: 'situation_worsening' },
        occurred_at: body.created_at,
      });
      const [outbox] = await outboxRows(s.incidentId);
      expect(outbox.payload).toEqual({
        incident_id: s.incidentId,
        resident_name: 'Tess Resident',
        occurred_at: body.created_at,
        update_id: body.id,
        preset: 'situation_worsening',
        text: null,
        recipient_user_ids: [s.member.id, s.other.id].sort(),
      });
      expect(await auditRows(s.incidentId)).toEqual([
        {
          actor_user_id: s.resident.id,
          detail: { update_id: body.id, preset: 'situation_worsening', text_length: null },
        },
      ]);
    });

    it('free text: trimmed and stored; the audit row has its length, never the text', async () => {
      const s = await scene();
      const reply = await send(s.resident.id, s.incidentId, { text: `  ${SECRET_TEXT}\n` });
      expect(reply.statusCode).toBe(201);
      const body = reply.json<Body>();
      expect(body).toMatchObject({ preset: null, text: SECRET_TEXT });
      expect((await eventRows(s.incidentId))[0].detail).toEqual({ text: SECRET_TEXT });
      const audits = await auditRows(s.incidentId);
      expect(audits).toEqual([
        {
          actor_user_id: s.resident.id,
          detail: { update_id: body.id, preset: null, text_length: [...SECRET_TEXT].length },
        },
      ]);
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from public.audit_log where detail::text like '%SECRET-UPDATE%'`,
      );
      expect(rows[0].n).toBe('0');
      // Neither the API nor the worker logged the text.
      await eventually(async () => {
        expect((await outboxRows(s.incidentId))[0]).toBeDefined();
      });
      await sleep(200);
      expect(logs.text).not.toContain('SECRET-UPDATE-TEXT');
      expect(workerLogs.text).not.toContain('SECRET-UPDATE-TEXT');
    });

    it('250 characters after trimming are accepted; 251 are 422', async () => {
      const s = await scene();
      const ok = await send(s.resident.id, s.incidentId, { text: ` ${'🚑'.repeat(250)} ` });
      expect(ok.statusCode).toBe(201);
      const tooLong = await send(s.resident.id, s.incidentId, { text: 'a'.repeat(251) });
      expect(tooLong.statusCode).toBe(422);
      expect(errorOf(tooLong)).toMatchObject({
        code: 'incident_updates:invalid_update',
        details: { field: 'text' },
      });
      expect(await eventRows(s.incidentId)).toHaveLength(1);
    });

    it.each([
      ['neither', {}, 'body'],
      ['both', { preset: 'help_is_here', text: 'x' }, 'body'],
      ['an array', [], 'body'],
      ['an unknown preset', { preset: 'all_good' }, 'preset'],
      ['empty text', { text: '   ' }, 'text'],
      ['text that is not a string', { text: 5 }, 'text'],
    ])('422 invalid_update for %s; nothing written', async (_label, body, field) => {
      const s = await scene();
      const reply = await send(s.resident.id, s.incidentId, body);
      expect(reply.statusCode).toBe(422);
      expect(errorOf(reply)).toMatchObject({
        code: 'incident_updates:invalid_update',
        details: { field },
      });
      await nothingWritten(s.incidentId);
    });

    it('a path id that is not a uuid is 422 validation:invalid_request', async () => {
      const s = await scene();
      const reply = await send(s.resident.id, 'not-a-uuid', { preset: 'help_is_here' });
      expect(reply.statusCode).toBe(422);
      expect(errorOf(reply)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'id' },
      });
    });

    it('a member, an outsider and an unknown id get 404 not_found; nothing written', async () => {
      const s = await scene();
      for (const [userId, incidentId] of [
        [s.member.id, s.incidentId],
        [s.outsider.id, s.incidentId],
        [s.resident.id, randomUUID()],
      ]) {
        const reply = await send(userId, incidentId, { preset: 'help_is_here' });
        expect(reply.statusCode).toBe(404);
        expect(errorOf(reply).code).toBe('incident_updates:not_found');
      }
      await nothingWritten(s.incidentId);
    });

    it('after mark safe (resolved) and once closed: 409 not_open; nothing written', async () => {
      const s = await scene();
      expect((await markSafe(app, s.resident.id, s.incidentId)).statusCode).toBe(200);
      const resolved = await send(s.resident.id, s.incidentId, { preset: 'help_is_here' });
      expect(resolved.statusCode).toBe(409);
      expect(errorOf(resolved).code).toBe('incident_updates:not_open');
      await client.query(
        `update public.incidents set status = 'closed', closed_at = now() where id = $1`,
        [s.incidentId],
      );
      const closed = await send(s.resident.id, s.incidentId, { text: 'still here' });
      expect(closed.statusCode).toBe(409);
      expect(errorOf(closed).code).toBe('incident_updates:not_open');
      await nothingWritten(s.incidentId);
    });

    it('Idempotency-Key: required; a replay answers the stored response and writes nothing new', async () => {
      const s = await scene();
      const missing = await send(s.resident.id, s.incidentId, { preset: 'help_is_here' }, '');
      expect(missing.statusCode).toBe(400);
      expect(errorOf(missing).code).toBe('idempotency:key_required');

      const key = randomUUID();
      const first = await send(s.resident.id, s.incidentId, { preset: 'help_is_here' }, key);
      const replay = await send(s.resident.id, s.incidentId, { preset: 'help_is_here' }, key);
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      const mismatch = await send(s.resident.id, s.incidentId, { text: 'other' }, key);
      expect(mismatch.statusCode).toBe(422);
      expect(errorOf(mismatch).code).toBe('idempotency:key_mismatch');
      expect(await eventRows(s.incidentId)).toHaveLength(1);
      expect(await outboxRows(s.incidentId)).toHaveLength(1);
      expect(await auditRows(s.incidentId)).toHaveLength(1);
    });

    it('rate limit: 10 per minute per alert, then 429 incident_updates:rate_limited with Retry-After', async () => {
      const s = await scene();
      for (let i = 0; i < 10; i++) {
        const reply = await send(s.resident.id, s.incidentId, { text: `update ${i}` });
        expect(reply.statusCode).toBe(201);
      }
      const over = await send(s.resident.id, s.incidentId, { preset: 'situation_worsening' });
      expect(over.statusCode).toBe(429);
      expect(errorOf(over).code).toBe('incident_updates:rate_limited');
      expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(await eventRows(s.incidentId)).toHaveLength(10);
      // Another alert has its own budget.
      const t = await scene();
      expect((await send(t.resident.id, t.incidentId, { text: 'mine' })).statusCode).toBe(201);
    });
  });

  describe('GET /v1/incidents/{id}/updates', () => {
    it('newest first; exactly {id, preset, text, created_at}; the same for the resident and members', async () => {
      const s = await scene();
      const a = (
        await send(s.resident.id, s.incidentId, { preset: 'situation_worsening' })
      ).json<Body>();
      const b = (await send(s.resident.id, s.incidentId, { text: 'Door is locked' })).json<Body>();
      const c = (await send(s.resident.id, s.incidentId, { preset: 'help_is_here' })).json<Body>();
      const resident = await list(s.resident.id, s.incidentId);
      expect(resident.statusCode).toBe(200);
      expect(resident.json()).toEqual([c, b, a]);
      const member = await list(s.member.id, s.incidentId);
      expect(member.statusCode).toBe(200);
      expect(member.json()).toEqual([c, b, a]);
      // No id of a person anywhere.
      for (const id of [s.resident.id, s.member.id, s.other.id]) {
        expect(member.body).not.toContain(id);
      }
    });

    it('an empty list before the first update', async () => {
      const s = await scene();
      expect((await list(s.member.id, s.incidentId)).json()).toEqual([]);
    });

    it('outsiders, pending, removed and late-joined members and unknown ids get 404', async () => {
      const s = await scene();
      await send(s.resident.id, s.incidentId, { preset: 'help_is_here' });
      const pending = await createUser(client);
      await inviteMember(client, s.circle, { claimedBy: pending });
      await client.query(
        `update public.safety_circle_members set status = 'removed', ended_at = now()
          where circle_id = $1 and user_id = $2`,
        [s.circle.id, s.other.id],
      );
      const late = await createUser(client);
      await client.query(
        `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                   invite_consumed_at, activated_at)
         values ($1, 'member', 'active', 'Late', $2, now() + interval '1 minute',
                 now() + interval '1 minute')`,
        [s.circle.id, late.id],
      );
      for (const [userId, incidentId] of [
        [s.outsider.id, s.incidentId],
        [pending.id, s.incidentId],
        [s.other.id, s.incidentId],
        [late.id, s.incidentId],
        [s.resident.id, randomUUID()],
      ]) {
        const reply = await list(userId, incidentId);
        expect(reply.statusCode).toBe(404);
        expect(errorOf(reply).code).toBe('incident_updates:not_found');
      }
    });

    it('stays readable (read-only) once resolved and once closed', async () => {
      const s = await scene();
      const a = (await send(s.resident.id, s.incidentId, { text: 'On my way out' })).json<Body>();
      await markSafe(app, s.resident.id, s.incidentId);
      expect((await list(s.member.id, s.incidentId)).json()).toEqual([a]);
      await client.query(
        `update public.incidents set status = 'closed', closed_at = now() where id = $1`,
        [s.incidentId],
      );
      expect((await list(s.member.id, s.incidentId)).json()).toEqual([a]);
      expect((await list(s.resident.id, s.incidentId)).json()).toEqual([a]);
    });

    it('the event log (activity feed) lists each update as a status_update event', async () => {
      const s = await scene();
      const a = (await send(s.resident.id, s.incidentId, { preset: 'help_is_here' })).json<Body>();
      const events = (await getIncidentEvents(app, s.member.id, s.incidentId)).json<Body[]>();
      const event = events.find((e) => e.event_type === 'status_update');
      expect(event).toMatchObject({ id: a.id, detail: { preset: 'help_is_here' } });
      // D11: a member sees the resident's id obscured.
      expect(event?.actor_id).not.toBe(s.resident.id);
    });
  });

  describe('live: incident.update', () => {
    it('to the incident room (resident and members), after the commit, with the REST entry', async () => {
      const s = await scene();
      const [resident, member, outsider] = await Promise.all([
        connect(s.resident),
        connect(s.member),
        connect(s.outsider),
      ]);
      expect(await resident.join(s.incidentId)).toEqual({ ok: true });
      expect(await member.join(s.incidentId)).toEqual({ ok: true });
      const reply = await send(s.resident.id, s.incidentId, { text: 'Door is locked' });
      const update = reply.json<Body>();
      const expected = {
        incident_id: s.incidentId,
        update,
        occurred_at: update.created_at,
      };
      expect(await member.next('incident.update')).toEqual(expected);
      expect(await resident.next('incident.update')).toEqual(expected);
      // The activity feed event comes with it.
      const event = await member.next<Body>('incident.event');
      expect(event.event).toMatchObject({ id: update.id, event_type: 'status_update' });
      await sleep(200);
      expect(outsider.of('incident.update')).toEqual([]);
      // A refused update broadcasts nothing.
      await markSafe(app, s.resident.id, s.incidentId);
      await send(s.resident.id, s.incidentId, { preset: 'help_is_here' });
      await sleep(200);
      expect(member.of('incident.update')).toHaveLength(1);
    });
  });

  describe('push: incident.status_update on the emergency channel', () => {
    async function pushRows(outboxId: string) {
      const { rows } = await client.query<{
        recipient_user_id: string;
        incident_id: string;
        status: string;
        error_code: string | null;
        provider_message_id: string | null;
      }>(
        `select recipient_user_id::text, incident_id::text, status, error_code, provider_message_id
           from public.notification_deliveries where outbox_id = $1 order by recipient_user_id`,
        [outboxId],
      );
      return rows;
    }

    it('one push per recipient device: title = resident name, body = preset text · HH:mm', async () => {
      const s = await scene();
      await registerDevice(app, s.member.id, randomUUID(), {
        platform: 'android',
        app_version: '1.0.0',
        push_provider: 'fcm',
        push_token: fakePushToken('milo'),
      });
      const update = (
        await send(s.resident.id, s.incidentId, { preset: 'situation_worsening' })
      ).json<Body>();
      const [outbox] = await outboxRows(s.incidentId);
      let rows: Awaited<ReturnType<typeof pushRows>> = [];
      await eventually(async () => {
        rows = await pushRows(outbox.id);
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.status !== 'queued')).toBe(true);
      }, 15_000);
      const milo = rows.find((r) => r.recipient_user_id === s.member.id)!;
      const ana = rows.find((r) => r.recipient_user_id === s.other.id)!;
      expect(milo).toMatchObject({ incident_id: s.incidentId, status: 'sent' });
      expect(ana).toMatchObject({ status: 'skipped', error_code: 'no_device' });
      const fake = push().sent.find((m) => m.provider_message_id === milo.provider_message_id);
      const { rows: hhmm } = await client.query<{ t: string }>(
        `select to_char(occurred_at at time zone 'Africa/Banjul', 'HH24:MI') as t
           from public.incident_events where id = $1`,
        [update.id],
      );
      expect(fake?.text).toEqual({
        title: 'Tess Resident',
        body: `Situation worsening · ${hhmm[0].t}`,
      });
      expect(fake?.content).toEqual({
        topic: 'incident.status_update',
        incident_id: s.incidentId,
        resident_name: 'Tess Resident',
        occurred_at: update.created_at,
        preset: 'situation_worsening',
        text: null,
      });
    });

    it('free text: the body is the text shortened to 100 characters plus the time', async () => {
      const s = await scene();
      await registerDevice(app, s.member.id, randomUUID(), {
        platform: 'android',
        app_version: '1.0.0',
        push_provider: 'fcm',
        push_token: fakePushToken('milo'),
      });
      const text = `${'Smoke '.repeat(30)}end`;
      const update = (await send(s.resident.id, s.incidentId, { text })).json<Body>();
      const [outbox] = await outboxRows(s.incidentId);
      let sentId: string | null = null;
      await eventually(async () => {
        const row = (await pushRows(outbox.id)).find((r) => r.recipient_user_id === s.member.id);
        expect(row?.status).toBe('sent');
        sentId = row!.provider_message_id;
      }, 15_000);
      const fake = push().sent.find((m) => m.provider_message_id === sentId);
      const { rows: hhmm } = await client.query<{ t: string }>(
        `select to_char(occurred_at at time zone 'Africa/Banjul', 'HH24:MI') as t
           from public.incident_events where id = $1`,
        [update.id],
      );
      const short = `${text.slice(0, 99).trimEnd()}…`;
      expect([...short].length).toBeLessThanOrEqual(100);
      expect(fake?.text).toEqual({ title: 'Tess Resident', body: `${short} · ${hhmm[0].t}` });
    });

    it('window applied at fan-out: a member removed since the alert is skipped not_eligible', async () => {
      const s = await scene();
      await client.query(
        `update public.safety_circle_members set status = 'removed', ended_at = now()
          where circle_id = $1 and user_id = $2`,
        [s.circle.id, s.other.id],
      );
      await send(s.resident.id, s.incidentId, { preset: 'help_is_here' });
      const [outbox] = await outboxRows(s.incidentId);
      await eventually(async () => {
        const rows = await pushRows(outbox.id);
        expect(rows.find((r) => r.recipient_user_id === s.other.id)).toMatchObject({
          status: 'skipped',
          error_code: 'not_eligible',
        });
      }, 15_000);
      // Only the alert's recipients: never the resident or an outsider.
      const ids = (await pushRows(outbox.id)).map((r) => r.recipient_user_id);
      expect(ids).not.toContain(s.resident.id);
      expect(ids).not.toContain(s.outsider.id);
    });
  });

  describe('race with mark safe', () => {
    it('an update and mark safe in parallel: the update is stored only while active; no deadlock', async () => {
      const ROUNDS = 8;
      const outcomes = new Set<number>();
      for (let round = 0; round < ROUNDS; round++) {
        const s = await scene();
        const [update, safe] = await Promise.all([
          send(s.resident.id, s.incidentId, { preset: 'situation_worsening' }),
          markSafe(app, s.resident.id, s.incidentId),
        ]);
        expect(safe.statusCode).toBe(200);
        expect(safe.json<Body>().status).toBe('resolved');
        expect([201, 409]).toContain(update.statusCode);
        outcomes.add(update.statusCode);
        if (update.statusCode === 201) {
          // Committed while the alert was active: exactly one event, outbox row and audit row.
          expect(await eventRows(s.incidentId)).toHaveLength(1);
          expect(await outboxRows(s.incidentId)).toHaveLength(1);
          expect(await auditRows(s.incidentId)).toHaveLength(1);
        } else {
          expect(errorOf(update).code).toBe('incident_updates:not_open');
          await nothingWritten(s.incidentId);
        }
        // After the race the alert refuses any further update.
        const after = await send(s.resident.id, s.incidentId, { text: 'later' });
        expect(after.statusCode).toBe(409);
      }
      expect(outcomes.size).toBeGreaterThanOrEqual(1);
    });
  });
});
