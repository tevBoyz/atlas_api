import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { httpStatusForCode } from '../../src/common/errors';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { leaveCircle, removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  inviteMember,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import { acknowledgeIncident, countRows, markSafe, submitAlert } from '../support/incident-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * SCRUM-49 / 50 / 51 / 55, decision D56: the member's response (`POST /v1/incidents/{id}/response`),
 * the responder list (`GET /v1/incidents/{id}/responders`) and the `incident.responders` broadcast.
 * Migration 0015 (two nullable columns on `incident_deliveries`), the check order and error codes,
 * idempotency, implied acknowledge, list content / order / ids (D79: own id only, handle), ended memberships
 * left out, audit, realtime per receiver on two instances, and races on separate connections
 * (acknowledge, mark safe, member removal: never a 40P01).
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<NestFastifyApplication['inject']>>;

const UTC_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const EVENT = 'incident.responders';
const RACE_ROUNDS = 20;
const KEYS = [
  'user_id',
  'handle',
  'display_name',
  'avatar_url',
  'status',
  'acknowledged_at',
  'status_at',
  'is_me',
];
/** SCRUM-65 (D73): the resident's rows also carry the delivery status, after `is_me`. */
const RESIDENT_KEYS = [...KEYS, 'delivery_status', 'delivery_at', 'delivery_failed_reason'];

describe('responder status (SCRUM-49/50/51/55, D56)', () => {
  let app: NestFastifyApplication;
  let appB: NestFastifyApplication;
  let url: string;
  let urlB: string;
  let client: Client;
  const open: TestSocket[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig({ DATABASE_POOL_MAX: '20' })));
    ({ app: appB } = await createTestApp());
    await app.listen(0, '127.0.0.1');
    await appB.listen(0, '127.0.0.1');
    url = await app.getUrl();
    urlB = await appB.getUrl();
    client = await openTestClient();
    await eventually(async () => {
      await app.get(RealtimeGateway).ping();
      await appB.get(RealtimeGateway).ping();
    });
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
    await appB.close();
  });

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    members: UserFixture[];
    memberRows: MemberFixture[];
    incidentId: string;
  }

  async function scene(count = 3, withPhones = false): Promise<Scene> {
    const resident = await createUser(client, { fullName: 'Rita Resident' });
    const circle = await createCircle(client, resident);
    const members: UserFixture[] = [];
    const memberRows: MemberFixture[] = [];
    for (let i = 0; i < count; i++) {
      const user = await createUser(client, {
        fullName: `Member ${i}`,
        phone: withPhones ? true : undefined,
      });
      memberRows.push(await addActiveMember(client, circle, user));
      members.push(user);
    }
    const reply = await submitAlert(app, resident.id, 'medical');
    expect(reply.statusCode).toBe(201);
    return { resident, circle, members, memberRows, incidentId: reply.json<Body>().id as string };
  }

  async function respond(userId: string, incidentId: string, body: unknown, on = app) {
    return on.inject({
      method: 'POST',
      url: `/v1/incidents/${incidentId}/response`,
      headers: { ...(await authHeader(userId)), 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  async function responders(userId: string, incidentId: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/incidents/${incidentId}/responders`,
      headers: await authHeader(userId),
    });
  }

  const errorOf = (reply: Reply) => reply.json<{ error: { code: string; details?: Body } }>().error;

  const delivery = async (incidentId: string, userId: string) =>
    (
      await client.query<{
        acknowledged_at: string | null;
        response_status: string | null;
        response_at: string | null;
      }>(
        `select acknowledged_at::text, response_status, response_at::text
           from public.incident_deliveries where incident_id = $1 and member_user_id = $2`,
        [incidentId, userId],
      )
    ).rows[0];

  const audits = (incidentId: string) =>
    client
      .query<Body>(
        `select actor_user_id::text, target_type, detail from public.audit_log
          where target_id = $1 and action = 'incident.response_set' order by id`,
        [incidentId],
      )
      .then((r) => r.rows);

  /** A member who joined one minute after the incident started, with a stray delivery row. */
  async function lateJoinerWithStrayRow(s: Scene): Promise<UserFixture> {
    const joiner = await createUser(client);
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                 invite_consumed_at, activated_at)
       values ($1, 'member', 'active', 'Joiner', $2, now() + interval '1 minute',
               now() + interval '1 minute')`,
      [s.circle.id, joiner.id],
    );
    await client.query(
      `insert into public.incident_deliveries (incident_id, member_id, member_user_id)
       select $1, m.id, $2 from public.safety_circle_members m
        where m.circle_id = $3 and m.user_id = $2`,
      [s.incidentId, joiner.id, s.circle.id],
    );
    return joiner;
  }

  describe('migration 0015', () => {
    it('adds two nullable columns; existing rows keep null; the checks refuse other values', async () => {
      const { rows } = await client.query<Body>(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public' and table_name = 'incident_deliveries'
            and column_name in ('response_status', 'response_at') order by column_name`,
      );
      expect(rows).toEqual([
        {
          column_name: 'response_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'response_status',
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
        },
      ]);
      const s = await scene(1);
      expect(await delivery(s.incidentId, s.members[0].id)).toEqual({
        acknowledged_at: null,
        response_status: null,
        response_at: null,
      });
      await expect(
        client.query(
          `update public.incident_deliveries set response_status = 'arrived', response_at = now()
            where incident_id = $1`,
          [s.incidentId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `update public.incident_deliveries set response_status = 'responding'
            where incident_id = $1`,
          [s.incidentId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('POST /v1/incidents/{id}/response', () => {
    it('responding: sets the status, its time and acknowledged_at; answers the own row', async () => {
      const s = await scene(2);
      const reply = await respond(s.members[0].id, s.incidentId, { status: 'responding' });
      expect(reply.statusCode).toBe(200);
      const body = reply.json<Body>();
      expect(Object.keys(body)).toEqual(KEYS);
      expect(body).toEqual({
        user_id: s.members[0].id,
        handle: s.memberRows[0].id,
        display_name: 'Member 0',
        avatar_url: null,
        status: 'responding',
        acknowledged_at: expect.stringMatching(UTC_TEXT) as unknown,
        status_at: expect.stringMatching(UTC_TEXT) as unknown,
        is_me: true,
      });
      const row = await delivery(s.incidentId, s.members[0].id);
      expect(row.response_status).toBe('responding');
      expect(row.acknowledged_at).not.toBeNull();
      expect(row.response_at).not.toBeNull();
      expect(await audits(s.incidentId)).toEqual([
        {
          actor_user_id: s.members[0].id,
          target_type: 'incident',
          detail: {
            delivery_id: expect.any(String) as unknown,
            status: 'responding',
            previous_status: null,
            acknowledged_now: true,
          },
        },
      ]);
      // Delivery counts count the implied acknowledge.
      const counts = await app.inject({
        method: 'GET',
        url: `/v1/incidents/${s.incidentId}/delivery-counts`,
        headers: await authHeader(s.resident.id),
      });
      expect(counts.json()).toMatchObject({ delivered_count: 2, acknowledged_count: 1 });
    });

    it('switch to unable: new response_at, acknowledged_at kept; the same status again changes nothing', async () => {
      const s = await scene(1);
      const member = s.members[0].id;
      expect((await acknowledgeIncident(app, member, s.incidentId)).statusCode).toBe(200);
      const acked = await delivery(s.incidentId, member);
      await sleep(20);
      await respond(member, s.incidentId, { status: 'responding' });
      const first = await delivery(s.incidentId, member);
      expect(first.acknowledged_at).toBe(acked.acknowledged_at);
      await sleep(20);
      const unable = await respond(member, s.incidentId, { status: 'unable' });
      expect(unable.statusCode).toBe(200);
      expect(unable.json()).toMatchObject({ status: 'unable', is_me: true });
      const second = await delivery(s.incidentId, member);
      expect(second.response_status).toBe('unable');
      expect(second.acknowledged_at).toBe(acked.acknowledged_at);
      expect(new Date(second.response_at!).getTime()).toBeGreaterThan(
        new Date(first.response_at!).getTime(),
      );
      await sleep(20);
      const again = await respond(member, s.incidentId, { status: 'unable' });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(unable.json());
      expect(await delivery(s.incidentId, member)).toEqual(second);
      // And back to responding.
      expect((await respond(member, s.incidentId, { status: 'responding' })).json()).toMatchObject({
        status: 'responding',
      });
      const rows = await audits(s.incidentId);
      expect(rows.map((r) => (r.detail as Body).status)).toEqual([
        'responding',
        'unable',
        'responding',
      ]);
      expect(rows.map((r) => (r.detail as Body).previous_status)).toEqual([
        null,
        'responding',
        'unable',
      ]);
      expect(rows.every((r) => (r.detail as Body).acknowledged_now === false)).toBe(true);
      // Acknowledge after a response stays a no-op.
      await acknowledgeIncident(app, member, s.incidentId);
      expect((await delivery(s.incidentId, member)).acknowledged_at).toBe(acked.acknowledged_at);
    });

    it('resolved → 409 incident_response:not_open; nothing written', async () => {
      const s = await scene(1);
      await respond(s.members[0].id, s.incidentId, { status: 'responding' });
      const before = await delivery(s.incidentId, s.members[0].id);
      expect((await markSafe(app, s.resident.id, s.incidentId)).statusCode).toBe(200);
      const reply = await respond(s.members[0].id, s.incidentId, { status: 'unable' });
      expect(reply.statusCode).toBe(409);
      expect(errorOf(reply).code).toBe('incident_response:not_open');
      expect(await delivery(s.incidentId, s.members[0].id)).toEqual(before);
    });

    it('not_found for every caller who is not a notified member inside the window; same body as unknown', async () => {
      const s = await scene(3);
      const joiner = await lateJoinerWithStrayRow(s);
      const outsider = await createUser(client);
      const pending = await createUser(client);
      await inviteMember(client, s.circle, { claimedBy: pending });
      expect(
        (await removeMember(app, s.resident.id, s.circle.id, s.memberRows[0].id)).statusCode,
      ).toBe(200);
      expect((await leaveCircle(app, s.members[1].id, s.circle.id)).statusCode).toBe(200);
      const unknown = await respond(outsider.id, '00000000-0000-4000-8000-0000000000aa', {
        status: 'responding',
      });
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).code).toBe('incident_response:not_found');
      for (const caller of [s.resident, outsider, pending, joiner, s.members[0], s.members[1]]) {
        const reply = await respond(caller.id, s.incidentId, { status: 'responding' });
        expect({ status: reply.statusCode, body: reply.body }).toEqual({
          status: 404,
          body: unknown.body,
        });
      }
      expect((await delivery(s.incidentId, joiner.id)).response_status).toBeNull();
      expect(await audits(s.incidentId)).toEqual([]);
    });

    it('every incident_response code is produced with its status', async () => {
      const s = await scene(1);
      const outsider = await createUser(client);
      const closed = await scene(1);
      await markSafe(app, closed.resident.id, closed.incidentId);
      const anonymous = await app.inject({
        method: 'POST',
        url: `/v1/incidents/${s.incidentId}/response`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ status: 'responding' }),
      });
      const produced: [string, Reply][] = [
        ['incident_response:not_authenticated', anonymous],
        [
          'incident_response:invalid_status',
          await respond(s.members[0].id, s.incidentId, { status: 'arrived' }),
        ],
        [
          'incident_response:not_found',
          await respond(outsider.id, s.incidentId, { status: 'unable' }),
        ],
        [
          'incident_response:not_open',
          await respond(closed.members[0].id, closed.incidentId, { status: 'unable' }),
        ],
      ];
      for (const [code, reply] of produced) {
        expect(errorOf(reply).code).toBe(code);
        expect(reply.statusCode).toBe(httpStatusForCode(code));
      }
      expect(errorOf(produced[1][1]).details).toEqual({ field: 'status' });
    });

    it('validation: a bad id or body is 422 validation:invalid_request before any check', async () => {
      const s = await scene(1);
      const badId = await respond(s.members[0].id, 'nope', { status: 'responding' });
      expect(badId.statusCode).toBe(422);
      expect(errorOf(badId)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'id' },
      });
      for (const body of [[], 'responding', 3]) {
        const reply = await respond(s.members[0].id, s.incidentId, body);
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply)).toMatchObject({ details: { field: 'body' } });
      }
      for (const status of [undefined, null, 'acknowledged', 'no_response', 'RESPONDING', 1]) {
        const reply = await respond(s.members[0].id, s.incidentId, { status });
        expect(errorOf(reply).code).toBe('incident_response:invalid_status');
      }
      expect((await delivery(s.incidentId, s.members[0].id)).response_status).toBeNull();
    });
  });

  describe('GET /v1/incidents/{id}/responders', () => {
    it('content, order, ids (D79): no other user id, handles; a member sees only their own id', async () => {
      const s = await scene(4, true);
      const [a, b, c, d] = s.members;
      await client.query(`update public.profiles set avatar_path = 'u/b.png' where id = $1`, [
        b.id,
      ]);
      await respond(c.id, s.incidentId, { status: 'unable' });
      await sleep(10);
      await acknowledgeIncident(app, d.id, s.incidentId);
      await sleep(10);
      await respond(b.id, s.incidentId, { status: 'responding' });
      await sleep(10);
      await acknowledgeIncident(app, a.id, s.incidentId);
      await sleep(10);
      await respond(a.id, s.incidentId, { status: 'responding' });
      // A fifth member who never answered.
      const e = await createUser(client, { fullName: '  Eve Quiet  ' });
      const eRow = await addActiveMember(client, s.circle, e);
      await client.query(
        `update public.safety_circle_members set activated_at = now() - interval '1 hour' where id = $1`,
        [eRow.id],
      );
      await client.query(
        `insert into public.incident_deliveries (incident_id, member_id, member_user_id) values ($1, $2, $3)`,
        [s.incidentId, eRow.id, e.id],
      );

      const asResident = await responders(s.resident.id, s.incidentId);
      expect(asResident.statusCode).toBe(200);
      const list = asResident.json<Body[]>();
      expect(list.map((r) => Object.keys(r))).toEqual(list.map(() => RESIDENT_KEYS));
      const h = (n: number) => s.memberRows[n].id;
      expect(list.map((r) => [r.user_id, r.handle, r.status, r.is_me])).toEqual([
        [null, h(1), 'responding', false],
        [null, h(0), 'responding', false],
        [null, h(3), 'acknowledged', false],
        [null, h(2), 'unable', false],
        [null, eRow.id, 'no_response', false],
      ]);
      expect(list[0].avatar_url).toMatch(/\/storage\/v1\/object\/public\/avatars\/u\/b\.png$/);
      expect(list[4]).toMatchObject({
        display_name: 'Eve Quiet',
        acknowledged_at: null,
        status_at: null,
      });
      for (const r of list.slice(0, 4)) expect(r.status_at).toMatch(UTC_TEXT);
      expect(JSON.stringify(list)).not.toMatch(/phone|email|\+1/);
      // SCRUM-65 (D73), no worker in this suite: the alert's outbox row is not fanned out, so the
      // notified members are "sent"; Eve's stray row was never in an alert notice: failed no_device.
      expect(list.map((r) => [r.delivery_status, r.delivery_at, r.delivery_failed_reason])).toEqual(
        [
          ['sent', null, null],
          ['sent', null, null],
          ['sent', null, null],
          ['sent', null, null],
          ['failed', null, 'no_device'],
        ],
      );

      const asMember = (await responders(d.id, s.incidentId)).json<Body[]>();
      expect(asMember.map((r) => [r.user_id, r.is_me])).toEqual([
        [null, false],
        [null, false],
        [d.id, true],
        [null, false],
        [null, false],
      ]);
      for (const id of [a.id, b.id, c.id, e.id]) expect(JSON.stringify(asMember)).not.toContain(id);
      // Everything but the ids is the same.
      const strip = (rows: Body[]) =>
        rows.map((r) => {
          const rest = { ...r };
          delete rest.user_id;
          delete rest.is_me;
          delete rest.delivery_status;
          delete rest.delivery_at;
          delete rest.delivery_failed_reason;
          return rest;
        });
      expect(strip(asMember)).toEqual(strip(list));
    });

    it('members whose membership ended are left out; they and outsiders get not_found', async () => {
      const s = await scene(3);
      const [a, b, c] = s.members;
      await respond(a.id, s.incidentId, { status: 'responding' });
      await respond(b.id, s.incidentId, { status: 'unable' });
      const joiner = await lateJoinerWithStrayRow(s);
      const outsider = await createUser(client);
      expect(
        (await removeMember(app, s.resident.id, s.circle.id, s.memberRows[0].id)).statusCode,
      ).toBe(200);
      expect((await leaveCircle(app, b.id, s.circle.id)).statusCode).toBe(200);
      const list = (await responders(s.resident.id, s.incidentId)).json<Body[]>();
      expect(list.map((r) => r.handle)).toEqual([s.memberRows[2].id]);
      const unknown = await responders(outsider.id, '00000000-0000-4000-8000-0000000000bb');
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).code).toBe('incident_responders:not_found');
      for (const caller of [a, b, outsider, joiner]) {
        const reply = await responders(caller.id, s.incidentId);
        expect({ status: reply.statusCode, body: reply.body }).toEqual({
          status: 404,
          body: unknown.body,
        });
      }
      // An incident of another circle stays hidden from a member.
      const other = await scene(1);
      expect((await responders(c.id, other.incidentId)).statusCode).toBe(404);
    });

    it('resolved: read-only, the statuses as they were at the close; no token 401', async () => {
      const s = await scene(2);
      await respond(s.members[0].id, s.incidentId, { status: 'responding' });
      const before = (await responders(s.members[1].id, s.incidentId)).json<Body[]>();
      await markSafe(app, s.resident.id, s.incidentId);
      const after = await responders(s.members[1].id, s.incidentId);
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual(before);
      expect((await responders(s.resident.id, s.incidentId)).statusCode).toBe(200);
      const anonymous = await app.inject({
        method: 'GET',
        url: `/v1/incidents/${s.incidentId}/responders`,
      });
      expect(anonymous.statusCode).toBe(401);
      expect(errorOf(anonymous).code).toBe('incident_responders:not_authenticated');
      expect(errorOf(await responders(s.resident.id, 'x')).code).toBe('validation:invalid_request');
    });
  });

  describe('incident.responders (realtime, two instances)', () => {
    async function connect(on: string, user: UserFixture) {
      const socket = await connectSocket(on, user.id);
      open.push(socket);
      return socket;
    }

    it('per receiver (D79): own row with own id and is_me, everyone else null + handle; outsider nothing', async () => {
      const s = await scene(3);
      const [a, b, c] = s.members;
      const outsider = await createUser(client);
      const rita = await connect(url, s.resident);
      const aSock = await connect(urlB, a);
      const bSock = await connect(url, b);
      const cSock = await connect(urlB, c); // never joins
      const outSock = await connect(url, outsider);
      for (const sock of [rita, aSock, bSock]) {
        await expect(sock.join(s.incidentId)).resolves.toEqual({ ok: true });
      }
      await expect(outSock.join(s.incidentId)).resolves.toMatchObject({ ok: false });

      // Acknowledge (through instance A).
      await acknowledgeIncident(app, a.id, s.incidentId);
      const ackR = await rita.next<Body>(EVENT);
      expect(Object.keys(ackR)).toEqual(['incident_id', 'responder', 'occurred_at']);
      expect(ackR).toMatchObject({
        incident_id: s.incidentId,
        responder: {
          user_id: null,
          handle: s.memberRows[0].id,
          status: 'acknowledged',
          is_me: false,
        },
        occurred_at: expect.stringMatching(UTC_TEXT) as unknown,
      });
      await expect(aSock.next<Body>(EVENT)).resolves.toMatchObject({
        responder: { user_id: a.id, status: 'acknowledged', is_me: true },
      });
      await expect(bSock.next<Body>(EVENT)).resolves.toMatchObject({
        responder: { user_id: null, status: 'acknowledged', is_me: false },
      });

      // Responding through instance B, then unable.
      await respond(a.id, s.incidentId, { status: 'responding' }, appB);
      const resp = await bSock.next<Body>(EVENT);
      expect(resp.responder).toMatchObject({ user_id: null, status: 'responding' });
      expect(Object.keys(resp.responder as Body)).toEqual(KEYS);
      // The event row equals what the list gives that receiver.
      const listB = (await responders(b.id, s.incidentId)).json<Body[]>();
      expect(listB.find((r) => r.handle === s.memberRows[0].id)).toEqual(resp.responder);
      await expect(rita.next<Body>(EVENT)).resolves.toMatchObject({
        responder: { user_id: null, handle: s.memberRows[0].id, status: 'responding' },
      });
      await expect(aSock.next<Body>(EVENT)).resolves.toMatchObject({
        responder: { user_id: a.id, is_me: true, status: 'responding' },
      });
      await respond(a.id, s.incidentId, { status: 'unable' });
      await expect(bSock.next<Body>(EVENT)).resolves.toMatchObject({
        responder: { status: 'unable' },
      });
      // A repeat sends nothing.
      await respond(a.id, s.incidentId, { status: 'unable' });
      await acknowledgeIncident(app, a.id, s.incidentId);
      await sleep(400);
      expect(rita.of(EVENT)).toHaveLength(3);
      expect(aSock.of(EVENT)).toHaveLength(3);
      expect(bSock.of(EVENT)).toHaveLength(3);
      // Each socket got each event once.
      expect(cSock.of(EVENT)).toEqual([]);
      expect(outSock.of(EVENT)).toEqual([]);
      expect(JSON.stringify(bSock.of(EVENT))).not.toContain(a.id);
      // The resident's delivery counts continue as before.
      expect(rita.of('incident.delivery_counts').length).toBeGreaterThanOrEqual(1);
      await markSafe(app, s.resident.id, s.incidentId);
    });

    it('a response that acknowledges also sends the resident incident.delivery_counts', async () => {
      const s = await scene(1);
      const rita = await connect(url, s.resident);
      await sleep(100);
      await respond(s.members[0].id, s.incidentId, { status: 'unable' });
      // (The submit's own counts event may arrive first.)
      await eventually(() => {
        expect(
          rita.of<Body>('incident.delivery_counts').map((c) => c.acknowledged_count),
        ).toContain(1);
      });
    });
  });

  describe('races on separate connections (zero 40P01)', () => {
    const isDeadlock = (x: unknown) => JSON.stringify(x).includes('40P01');

    it(`response racing acknowledge of the same member, ${RACE_ROUNDS} rounds`, async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(1);
        const m = s.members[0].id;
        const [r, k] = await Promise.all([
          respond(m, s.incidentId, { status: 'responding' }),
          acknowledgeIncident(app, m, s.incidentId),
        ]);
        expect(isDeadlock(r.body) || isDeadlock(k.body)).toBe(false);
        expect([r.statusCode, k.statusCode]).toEqual([200, 200]);
        const row = await delivery(s.incidentId, m);
        expect(row.response_status).toBe('responding');
        expect(row.acknowledged_at).not.toBeNull();
        expect(k.json()).toMatchObject({ acknowledged_count: 1 });
      }
    }, 120_000);

    it(`response racing mark safe, ${RACE_ROUNDS} rounds: set, or not_open`, async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(2);
        const m = s.members[round % 2].id;
        const [r, closed] = await Promise.all([
          respond(m, s.incidentId, { status: round % 3 === 0 ? 'unable' : 'responding' }),
          markSafe(app, s.resident.id, s.incidentId),
        ]);
        expect(isDeadlock(r.body) || isDeadlock(closed.body)).toBe(false);
        expect(closed.statusCode).toBe(200);
        const row = await delivery(s.incidentId, m);
        if (r.statusCode === 200) expect(row.response_status).not.toBeNull();
        else {
          expect(errorOf(r).code).toBe('incident_response:not_open');
          expect(row.response_status).toBeNull();
        }
      }
    }, 120_000);

    it(`response racing the member's removal, ${RACE_ROUNDS} rounds: set then removed, or not_found`, async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(1);
        const [r, removed] = await Promise.all([
          respond(s.members[0].id, s.incidentId, { status: 'responding' }),
          removeMember(app, s.resident.id, s.circle.id, s.memberRows[0].id),
        ]);
        expect(isDeadlock(r.body) || isDeadlock(removed.body)).toBe(false);
        expect(removed.statusCode).toBe(200);
        if (r.statusCode !== 200) expect(errorOf(r).code).toBe('incident_response:not_found');
        // Either way the member is off the list (D44 deleted the delivery row).
        const list = (await responders(s.resident.id, s.incidentId)).json<Body[]>();
        expect(list).toEqual([]);
      }
    }, 120_000);

    it('response racing acknowledge, mark safe and removal at once: no error but the expected codes', async () => {
      for (let round = 0; round < 10; round++) {
        const s = await scene(2);
        const [a, b] = s.members;
        const replies = await Promise.all([
          respond(a.id, s.incidentId, { status: 'responding' }),
          acknowledgeIncident(app, a.id, s.incidentId),
          respond(b.id, s.incidentId, { status: 'unable' }),
          removeMember(app, s.resident.id, s.circle.id, s.memberRows[1].id),
          markSafe(app, s.resident.id, s.incidentId),
        ]);
        for (const reply of replies) {
          expect(isDeadlock(reply.body)).toBe(false);
          expect(reply.statusCode).toBeLessThan(500);
        }
        expect(
          await countRows(
            client,
            `select count(*)::int as n from public.incidents where id = $1 and status = 'resolved'`,
            [s.incidentId],
          ),
        ).toBe(1);
      }
    }, 120_000);
  });
});
