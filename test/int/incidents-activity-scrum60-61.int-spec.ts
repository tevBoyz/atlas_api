import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { REALTIME_CONTRACT } from '../../src/realtime/realtime.contract';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import {
  acknowledgeIncident,
  getIncidentEvents,
  markSafe,
  renotifyAlert,
  sendIncidentUpdate,
  submitAlert,
} from '../support/incident-api';
import { connectSocket, eventually, type TestSocket } from '../support/realtime-client';

/**
 * SCRUM-60 (Incident Activity Feed) + SCRUM-61 (Live Incident Timeline), decision D71: a member's
 * first acknowledge writes one `responder_acknowledged` event (actor = the member, detail `{}`), a
 * repeat none; each change of their response writes one `responder_status` event `{status}` (the
 * same status again none; the first response also acknowledges, so `responder_acknowledged` comes
 * first); every event of `GET /v1/incidents/{id}/events` and `incident.event` carries `actor_name`
 * (the same for every caller; members still never get `recipient_ids`); no push for them; and the
 * new lock order (profile → incident → delivery) never deadlocks with a re-notify or mark safe.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<NestFastifyApplication['inject']>>;
const CONFIG = {
  RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
  RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
  DATABASE_POOL_MAX: '30',
};
const RACE_ROUNDS = 15;

describe('SCRUM-60/61 activity feed events (D71)', () => {
  let app: NestFastifyApplication;
  let url: string;
  let client: Client;
  const open: TestSocket[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    client = await openTestClient();
    await eventually(() => app.get(RealtimeGateway).ping());
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  async function respond(userId: string, incidentId: string, status: string): Promise<Reply> {
    return app.inject({
      method: 'POST',
      url: `/v1/incidents/${incidentId}/response`,
      headers: { ...(await authHeader(userId)), 'content-type': 'application/json' },
      payload: JSON.stringify({ status }),
    });
  }

  async function connect(user: UserFixture): Promise<TestSocket> {
    const socket = await connectSocket(url, user.id);
    open.push(socket);
    return socket;
  }

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    milo: UserFixture;
    ned: UserFixture;
    incidentId: string;
  }

  /** Rita (resident, name with spaces) with Milo and Ned (active members); her alert is active. */
  async function scene(): Promise<Scene> {
    const resident = await createUser(client, { fullName: '  Rita Resident ' });
    const circle = await createCircle(client, resident);
    const milo = await createUser(client, { fullName: ' Milo Member ' });
    const ned = await createUser(client, { fullName: 'Ned Member' });
    await addActiveMember(client, circle, milo);
    await addActiveMember(client, circle, ned);
    const reply = await submitAlert(app, resident.id, 'fire');
    expect(reply.statusCode).toBe(201);
    return { resident, circle, milo, ned, incidentId: reply.json<Body>().id as string };
  }

  /** The stored responder events, oldest first: `[type, actor_id, detail]`. */
  async function responderEvents(incidentId: string): Promise<[string, string, Body][]> {
    const { rows } = await client.query<{ event_type: string; actor_id: string; detail: Body }>(
      `select event_type, actor_id::text as actor_id, detail from public.incident_events
        where incident_id = $1 and event_type in ('responder_acknowledged', 'responder_status')
        order by occurred_at, id`,
      [incidentId],
    );
    return rows.map((row) => [row.event_type, row.actor_id, row.detail]);
  }

  async function outboxCount(incidentId: string): Promise<number> {
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from public.notification_outbox where aggregate_id = $1`,
      [incidentId],
    );
    return rows[0].n;
  }

  describe('writers', () => {
    it('acknowledge: the first writes one responder_acknowledged {}, a repeat none', async () => {
      const s = await scene();
      expect((await acknowledgeIncident(app, s.milo.id, s.incidentId)).statusCode).toBe(200);
      expect(await responderEvents(s.incidentId)).toEqual([
        ['responder_acknowledged', s.milo.id, {}],
      ]);
      expect((await acknowledgeIncident(app, s.milo.id, s.incidentId)).statusCode).toBe(200);
      expect((await acknowledgeIncident(app, s.milo.id, s.incidentId)).statusCode).toBe(200);
      expect(await responderEvents(s.incidentId)).toEqual([
        ['responder_acknowledged', s.milo.id, {}],
      ]);
      // A response after the acknowledge does not acknowledge again.
      expect((await respond(s.milo.id, s.incidentId, 'responding')).statusCode).toBe(200);
      expect(await responderEvents(s.incidentId)).toEqual([
        ['responder_acknowledged', s.milo.id, {}],
        ['responder_status', s.milo.id, { status: 'responding' }],
      ]);
      // An acknowledge after the response stays a no-op.
      expect((await acknowledgeIncident(app, s.milo.id, s.incidentId)).statusCode).toBe(200);
      expect(await responderEvents(s.incidentId)).toHaveLength(2);
    });

    it('response: the first acknowledges first; the same status again none; responding → unable', async () => {
      const s = await scene();
      expect((await respond(s.ned.id, s.incidentId, 'responding')).statusCode).toBe(200);
      expect(await responderEvents(s.incidentId)).toEqual([
        ['responder_acknowledged', s.ned.id, {}],
        ['responder_status', s.ned.id, { status: 'responding' }],
      ]);
      expect((await respond(s.ned.id, s.incidentId, 'responding')).statusCode).toBe(200);
      expect(await responderEvents(s.incidentId)).toHaveLength(2);
      expect((await respond(s.ned.id, s.incidentId, 'unable')).statusCode).toBe(200);
      expect((await respond(s.ned.id, s.incidentId, 'unable')).statusCode).toBe(200);
      expect((await respond(s.ned.id, s.incidentId, 'responding')).statusCode).toBe(200);
      expect(await responderEvents(s.incidentId)).toEqual([
        ['responder_acknowledged', s.ned.id, {}],
        ['responder_status', s.ned.id, { status: 'responding' }],
        ['responder_status', s.ned.id, { status: 'unable' }],
        ['responder_status', s.ned.id, { status: 'responding' }],
      ]);
    });

    it('responding → unable: two status events in order, each later than the one before', async () => {
      const s = await scene();
      await respond(s.milo.id, s.incidentId, 'responding');
      await respond(s.milo.id, s.incidentId, 'unable');
      const { rows } = await client.query<{ status: string; later: boolean | null }>(
        `select detail->>'status' as status,
                occurred_at > lag(occurred_at) over (order by occurred_at, id) as later
           from public.incident_events
          where incident_id = $1 and event_type = 'responder_status'
          order by occurred_at, id`,
        [s.incidentId],
      );
      expect(rows).toEqual([
        { status: 'responding', later: null },
        { status: 'unable', later: true },
      ]);
    });

    it('refused calls write no event; no push for acknowledgements or responses', async () => {
      const s = await scene();
      const outbox = await outboxCount(s.incidentId);
      await acknowledgeIncident(app, s.milo.id, s.incidentId);
      await respond(s.milo.id, s.incidentId, 'responding');
      await respond(s.ned.id, s.incidentId, 'unable');
      expect(await outboxCount(s.incidentId)).toBe(outbox);
      expect(await responderEvents(s.incidentId)).toHaveLength(4);
      // An outsider (no delivery row) and the resident are refused: nothing written.
      const outsider = await createUser(client);
      expect((await acknowledgeIncident(app, outsider.id, s.incidentId)).statusCode).toBe(404);
      expect((await respond(s.resident.id, s.incidentId, 'responding')).statusCode).toBe(404);
      // A resolved alert is frozen.
      expect((await markSafe(app, s.resident.id, s.incidentId)).statusCode).toBe(200);
      expect((await respond(s.milo.id, s.incidentId, 'unable')).statusCode).toBe(409);
      expect((await acknowledgeIncident(app, s.ned.id, s.incidentId)).statusCode).toBe(409);
      expect(await responderEvents(s.incidentId)).toHaveLength(4);
    });
  });

  describe('GET /v1/incidents/{id}/events: actor_name', () => {
    it('the same names for the resident and for a member; members get no recipient_ids', async () => {
      const s = await scene();
      await acknowledgeIncident(app, s.milo.id, s.incidentId);
      await respond(s.milo.id, s.incidentId, 'responding');
      await respond(s.ned.id, s.incidentId, 'unable');
      expect(
        (await sendIncidentUpdate(app, s.resident.id, s.incidentId, { preset: 'help_is_here' }))
          .statusCode,
      ).toBe(201);
      // The profile name wins over the membership name, as the responder list (a profile name is
      // never blank: profiles_full_name_nonempty).
      await client.query(
        `update public.safety_circle_members set display_name = 'Ned From Membership'
          where circle_id = $1 and user_id = $2`,
        [s.circle.id, s.ned.id],
      );
      await client.query(
        `insert into public.incident_events (incident_id, event_type, actor_id, detail)
         values ($1, 'renotified', null, '{"recipient_count": 2}'::jsonb)`,
        [s.incidentId],
      );

      const resident = await getIncidentEvents(app, s.resident.id, s.incidentId);
      const member = await getIncidentEvents(app, s.milo.id, s.incidentId);
      expect(resident.statusCode).toBe(200);
      expect(member.statusCode).toBe(200);
      // Gap 59: location_sharing_started is stored at clock_timestamp(), so it always follows
      // alert_sent (strict order, not sorted).
      const view = (reply: Reply) =>
        reply.json<Body[]>().map((e) => [e.event_type, e.actor_name, e.detail]);
      const expected = [
        [
          'alert_sent',
          'Rita Resident',
          {
            recipient_count: 2,
            recipient_ids: [s.milo.id, s.ned.id].sort(),
            emergency_type: 'fire',
          },
        ],
        ['location_sharing_started', 'Rita Resident', {}],
        ['responder_acknowledged', 'Milo Member', {}],
        ['responder_status', 'Milo Member', { status: 'responding' }],
        ['responder_acknowledged', 'Ned Member', {}],
        ['responder_status', 'Ned Member', { status: 'unable' }],
        ['status_update', 'Rita Resident', { preset: 'help_is_here' }],
        ['renotified', null, { recipient_count: 2 }],
      ];
      expect(view(resident)).toEqual(expected);
      // D3: a member never gets recipient_ids; recipient_count and every name stay.
      expect(view(member)).toEqual(
        expected.map(([type, name, detail]) => {
          const copy = { ...(detail as Body) };
          delete copy.recipient_ids;
          return [type, name, copy];
        }),
      );
      expect(member.body).not.toContain('recipient_ids');
      expect(member.body).not.toContain(s.ned.id);
      for (const event of member.json<Body[]>()) {
        expect(Object.keys(event).sort()).toEqual([
          'actor_id',
          'actor_name',
          'detail',
          'event_type',
          'id',
          'occurred_at',
        ]);
      }
      // D11 unchanged: Milo sees his own id in full and the others masked.
      const milo = member.json<Body[]>().filter((e) => e.actor_name === 'Milo Member');
      for (const event of milo) expect(event.actor_id).toBe(s.milo.id);
      const ned = member.json<Body[]>().filter((e) => e.actor_name === 'Ned Member');
      for (const event of ned) expect(event.actor_id).toMatch(/\*{4}/);
    });

    it('the timeline stays readable after the close (SCRUM-61)', async () => {
      const s = await scene();
      await respond(s.milo.id, s.incidentId, 'responding');
      await markSafe(app, s.resident.id, s.incidentId);
      const reply = await getIncidentEvents(app, s.ned.id, s.incidentId);
      expect(reply.statusCode).toBe(200);
      expect(reply.json<Body[]>().map((e) => e.event_type)).toEqual(
        expect.arrayContaining([
          'responder_acknowledged',
          'responder_status',
          'safe_recorded',
          'location_sharing_ended',
        ]),
      );
    });
  });

  describe('live: incident.event', () => {
    it('acknowledge and responses reach the room in order with actor_name and the contract keys', async () => {
      const s = await scene();
      const [resident, milo, ned] = await Promise.all([
        connect(s.resident),
        connect(s.milo),
        connect(s.ned),
      ]);
      for (const socket of [resident, milo, ned]) {
        expect(await socket.join(s.incidentId)).toEqual({ ok: true });
      }
      // Each broadcast runs after its commit, not awaited by the request: every socket waits for
      // the event itself (gap 60: on the event, not on a fixed time) before the next call, so the
      // expected order is the order of the calls.
      const sockets = [resident, milo, ned];
      const got: Body[][] = sockets.map(() => []);
      const nextOnEach = async () => {
        const payloads = await Promise.all(
          sockets.map((socket) => socket.next<Body>('incident.event', 30_000)),
        );
        payloads.forEach((payload, i) => got[i].push(payload));
      };
      await acknowledgeIncident(app, s.milo.id, s.incidentId);
      await nextOnEach();
      await respond(s.milo.id, s.incidentId, 'responding');
      await nextOnEach();
      await respond(s.milo.id, s.incidentId, 'unable');
      await nextOnEach();

      const keys = REALTIME_CONTRACT.server_events['incident.event'];
      for (const payloads of got) {
        for (const payload of payloads) {
          expect(Object.keys(payload)).toEqual(keys.payload);
          expect(Object.keys(payload.event as Body)).toEqual(keys.event_keys);
        }
        expect(
          payloads.map((p) => {
            const e = p.event as Body;
            return [e.event_type, e.actor_name, e.detail];
          }),
        ).toEqual([
          ['responder_acknowledged', 'Milo Member', {}],
          ['responder_status', 'Milo Member', { status: 'responding' }],
          ['responder_status', 'Milo Member', { status: 'unable' }],
        ]);
      }
      // D11 per receiver: the resident and Milo himself get his id, Ned gets it masked.
      expect((got[0][0].event as Body).actor_id).toBe(s.milo.id);
      expect((got[1][0].event as Body).actor_id).toBe(s.milo.id);
      expect((got[2][0].event as Body).actor_id).toMatch(/\*{4}/);
      // A repeat acknowledge and the same status again broadcast no event: a status change after
      // them is the very next event every socket gets (a barrier, not a fixed wait).
      await acknowledgeIncident(app, s.milo.id, s.incidentId);
      await respond(s.milo.id, s.incidentId, 'unable');
      await respond(s.milo.id, s.incidentId, 'responding');
      for (const socket of sockets) {
        const marker = await socket.next<Body>('incident.event', 30_000);
        expect((marker.event as Body).detail).toEqual({ status: 'responding' });
        expect(socket.of('incident.event')).toHaveLength(4);
      }
    });

    it('a member never gets recipient_ids live; the resident does', async () => {
      const s = await scene();
      const [resident, ned] = await Promise.all([connect(s.resident), connect(s.ned)]);
      expect(await resident.join(s.incidentId)).toEqual({ ok: true });
      expect(await ned.join(s.incidentId)).toEqual({ ok: true });
      await markSafe(app, s.resident.id, s.incidentId);
      const closure = async (socket: TestSocket) => {
        for (;;) {
          const payload = await socket.next<Body>('incident.event');
          const event = payload.event as Body;
          if (event.event_type === 'closure_notified') return event;
        }
      };
      const forNed = await closure(ned);
      expect(forNed.detail).toEqual({ recipient_count: 2 });
      expect(forNed.actor_name).toBe('Rita Resident');
      const forResident = await closure(resident);
      expect((forResident.detail as Body).recipient_ids).toEqual([s.milo.id, s.ned.id].sort());
      expect(forResident.actor_name).toBe('Rita Resident');
    });
  });

  describe('lock order (profile → incident → delivery)', () => {
    it('acknowledge and responses racing re-notify and mark safe never fail or deadlock', async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene();
        const replies = await Promise.all([
          acknowledgeIncident(app, s.milo.id, s.incidentId),
          respond(s.ned.id, s.incidentId, 'responding'),
          renotifyAlert(app, s.resident.id, s.incidentId),
          respond(s.milo.id, s.incidentId, 'unable'),
          round % 2 === 0
            ? markSafe(app, s.resident.id, s.incidentId)
            : renotifyAlert(app, s.resident.id, s.incidentId),
        ]);
        for (const reply of replies) expect(reply.statusCode).toBeLessThan(500);
        // Every response that changed something has its event; never a duplicate acknowledge.
        const { rows } = await client.query<{
          user_id: string;
          acks: number;
          status: string | null;
        }>(
          `select d.member_user_id::text as user_id,
                  (select count(*)::int from public.incident_events e
                    where e.incident_id = d.incident_id and e.actor_id = d.member_user_id
                      and e.event_type = 'responder_acknowledged') as acks,
                  d.response_status as status
             from public.incident_deliveries d where d.incident_id = $1`,
          [s.incidentId],
        );
        for (const row of rows) expect(row.acks).toBeLessThanOrEqual(1);
        for (const row of rows.filter((r) => r.status !== null)) expect(row.acks).toBe(1);
      }
    });
  });
});
