import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import {
  asSqlSharePayloadShape,
  GM_EMERGENCY_SERVICES,
  withoutClosedAtText,
} from '../support/share-payload-shape';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  inviteMember,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import {
  attachLocation,
  callSqlAs,
  getIncidentDetails,
  listResponderIncidents,
  markSafe,
  setIncidentNotes,
  sqlOutcomeAs,
  submitAlert,
} from '../support/incident-api';

/**
 * `GET /v1/responder/incidents` and `GET /v1/incidents/{id}` (API-100-21) beyond the SQL scripts:
 * exact key sets (members never get `resident_id`, `circle_id` or other profile data), the list
 * filter and ordering, hidden existence for every denied caller, byte-for-byte interchangeability
 * with `list_responder_incidents` / `get_incident_details`, and reads racing membership changes and
 * a close on separate connections.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof getIncidentDetails>>;

const RACE_ROUNDS = 25;

const LIST_KEYS = [
  'activated_at',
  'auto_closed',
  // SCRUM-63 (D61, D63): after the SQL keys.
  'closed_at',
  'emergency_type',
  'id',
  'renotified_at',
  'resident_name',
  'resolved_at',
  'resolved_reason',
  'sent_at',
  'status',
];

const DETAIL_KEYS = [
  ...LIST_KEYS,
  'incident_notes',
  'incident_notes_updated_at',
  'location_accuracy_m',
  'location_captured_at',
  'location_lat',
  'location_lng',
  'location_sharing_ended_at',
  'location_source',
  'share_payload',
  // SCRUM-21 (D53): the activation snapshot and when the live view last changed.
  'share_payload_at_activation',
  'share_payload_updated_at',
  // SCRUM-54 (D60): the local emergency numbers.
  'emergency_services',
].sort();

describe('responder incident list and details (API-100-21)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig({ DATABASE_POOL_MAX: '20' })));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const errorOf = (reply: Reply) => reply.json<{ error: { code: string; details: Body } }>().error;

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    members: UserFixture[];
    memberRows: MemberFixture[];
  }

  async function scene(count = 2, fullName?: string): Promise<Scene> {
    const resident = await createUser(client, fullName ? { fullName } : {});
    const circle = await createCircle(client, resident);
    const members: UserFixture[] = [];
    const memberRows: MemberFixture[] = [];
    for (let i = 0; i < count; i++) {
      const user = await createUser(client);
      memberRows.push(await addActiveMember(client, circle, user));
      members.push(user);
    }
    return { resident, circle, members, memberRows };
  }

  const submit = async (residentId: string, type = 'medical') => {
    const reply = await submitAlert(app, residentId, type);
    expect([200, 201]).toContain(reply.statusCode);
    return reply.json<Body>().id as string;
  };

  /** An incident row in any state, written directly (legacy rows the API cannot create). */
  async function insertIncident(
    s: Scene,
    fields: {
      status: string;
      activatedAt: string;
      sentAt?: string | null;
      resolvedAt?: string | null;
      circle?: boolean;
    },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.incidents (resident_id, circle_id, status, emergency_type, activated_at,
                                     sent_at, resolved_at, resolved_reason, cancelled_at)
       values ($1, $2, $3, 'fire', ${fields.activatedAt}, ${fields.sentAt ?? 'null'},
               ${fields.resolvedAt ?? 'null'},
               case when $3 = 'resolved' then 'safe' end,
               case when $3 = 'cancelled' then now() end)
       returning id`,
      [s.resident.id, fields.circle === false ? null : s.circle.id, fields.status],
    );
    return rows[0].id;
  }

  async function lateJoiner(s: Scene): Promise<UserFixture> {
    const joiner = await createUser(client);
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                 invite_consumed_at, activated_at)
       values ($1, 'member', 'active', 'Joiner', $2, now() + interval '1 minute',
               now() + interval '1 minute')`,
      [s.circle.id, joiner.id],
    );
    return joiner;
  }

  const listIds = async (userId: string) =>
    (await listResponderIncidents(app, userId)).json<Body[]>().map((row) => row.id);

  describe('GET /v1/responder/incidents', () => {
    it('no token: 401 list_responder_incidents:not_authenticated', async () => {
      const reply = await app.inject({ method: 'GET', url: '/v1/responder/incidents' });
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('list_responder_incidents:not_authenticated');
    });

    it('AC3: exactly the 10 keys; never resident_id, circle_id or other profile data', async () => {
      const s = await scene(1, 'Resident Keys');
      const id = await submit(s.resident.id);
      const rows = (await listResponderIncidents(app, s.members[0].id)).json<Body[]>();
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(LIST_KEYS);
      expect(rows[0]).toMatchObject({
        id,
        resident_name: 'Resident Keys',
        status: 'active',
        emergency_type: 'medical',
        auto_closed: false,
      });
      const text = JSON.stringify(rows);
      expect(text).not.toContain(s.resident.id);
      expect(text).not.toContain(s.circle.id);
    });

    it('filter: active/resolved of current circles inside the window; never own, legacy or pre-join', async () => {
      const s = await scene(1);
      const viewer = s.members[0];
      const active = await submit(s.resident.id);
      await markSafe(app, s.resident.id, active);
      const open = await submit(s.resident.id, 'fire');
      const preJoin = await insertIncident(s, {
        status: 'resolved',
        activatedAt: `now() - interval '30 days'`,
        sentAt: `now() - interval '30 days'`,
        resolvedAt: `now() - interval '29 days'`,
      });
      const cancelled = await insertIncident(s, { status: 'cancelled', activatedAt: 'now()' });
      const noCircle = await insertIncident(s, {
        status: 'resolved',
        activatedAt: 'now()',
        sentAt: 'now()',
        resolvedAt: 'now()',
        circle: false,
      });
      // The viewer's own alert in another circle where the resident is a member.
      const own = await createCircle(client, viewer);
      await addActiveMember(client, own, s.resident);
      const viewerOwn = await submit(viewer.id);

      const ids = await listIds(viewer.id);
      expect(ids).toEqual(expect.arrayContaining([active, open]));
      for (const hidden of [preJoin, cancelled, noCircle, viewerOwn]) {
        expect(ids).not.toContain(hidden);
      }
      // ...and the resident sees the viewer's alert as a member of the viewer's circle.
      expect(await listIds(s.resident.id)).toEqual([viewerOwn]);
    });

    it('ordering: coalesce(resolved_at, sent_at, activated_at) desc, then id asc on ties', async () => {
      const s = await scene(1);
      const other = await scene(0);
      await addActiveMember(client, other.circle, s.members[0]);
      // Backdated memberships, as the migration role may (the trigger refuses it to clients only).
      await client.query(
        `update public.safety_circle_members set activated_at = now() - interval '10 days'
          where circle_id = any($1::uuid[])`,
        [[s.circle.id, other.circle.id]],
      );
      const tie = `timestamptz '2026-11-10 12:00:00+00'`;
      const ids = [
        await insertIncident(s, {
          status: 'resolved',
          activatedAt: `now() - interval '5 days'`,
          sentAt: `now() - interval '5 days'`,
          resolvedAt: `now() - interval '1 day'`,
        }),
        await insertIncident(s, {
          status: 'resolved',
          activatedAt: `now() - interval '9 days'`,
          sentAt: null,
          resolvedAt: tie,
        }),
        await insertIncident(s, {
          status: 'resolved',
          activatedAt: `now() - interval '8 days'`,
          sentAt: `now() - interval '8 days'`,
          resolvedAt: tie,
        }),
        await insertIncident(s, {
          status: 'resolved',
          activatedAt: `now() - interval '3 days'`,
          sentAt: `now() - interval '3 days'`,
          resolvedAt: tie,
        }),
        await insertIncident(s, { status: 'active', activatedAt: `now() - interval '2 days'` }),
        // One open alert per resident: the second active one is another resident's, same viewer.
        await insertIncident(other, {
          status: 'active',
          activatedAt: `now() - interval '7 days'`,
          sentAt: `now() - interval '6 days'`,
        }),
      ];
      const { rows } = await client.query<{ id: string }>(
        `select id::text from public.incidents where id = any($1::uuid[])
          order by coalesce(resolved_at, sent_at, activated_at) desc, id`,
        [ids],
      );
      const listed = await listIds(s.members[0].id);
      expect(listed).toEqual(rows.map((row) => row.id));
      expect(new Set(listed).size).toBe(listed.length);
    });

    it('interchangeable with list_responder_incidents: the same bytes for every caller', async () => {
      const s = await scene(2);
      const a = await submit(s.resident.id);
      await attachLocation(app, s.resident.id, a, {
        location_source: 'current',
        location_lat: 9.03,
        location_lng: 38.74,
        location_accuracy_m: 5,
        location_captured_at: new Date().toISOString(),
      });
      await markSafe(app, s.resident.id, a);
      await submit(s.resident.id, 'burglary');
      const joiner = await lateJoiner(s);
      const outsider = await createUser(client);
      for (const caller of [s.members[0], s.members[1], s.resident, joiner, outsider]) {
        const api = await listResponderIncidents(app, caller.id);
        const sql = await callSqlAs(client, caller.id, 'public.list_responder_incidents()');
        expect(api.statusCode).toBe(200);
        // SCRUM-63 (D63): `closed_at` (null here) is the API's only extra key.
        expect(withoutClosedAtText(api.body)).toBe(JSON.stringify(sql));
      }
    });
  });

  describe('GET /v1/incidents/{id}', () => {
    it('no token: 401 get_incident_details:not_authenticated; bad id: 422 on field id', async () => {
      const anonymous = await app.inject({
        method: 'GET',
        url: '/v1/incidents/00000000-0000-4000-8000-000000000000',
      });
      expect(anonymous.statusCode).toBe(401);
      expect(errorOf(anonymous).code).toBe('get_incident_details:not_authenticated');
      const user = await createUser(client);
      const bad = await getIncidentDetails(app, user.id, 'nope');
      expect(bad.statusCode).toBe(422);
      expect(errorOf(bad).details).toEqual({ field: 'id' });
    });

    it('AC2, AC3: the 19 SQL keys + 2 SCRUM-21 keys + emergency_services (D60), share_payload stored or {}, no resident_id/circle_id', async () => {
      const s = await scene(1, 'Resident Details');
      await client.query(
        `update public.profiles set blood_type = 'O+', share_blood_type = true where id = $1`,
        [s.resident.id],
      );
      const id = await submit(s.resident.id, 'domestic_violence');
      await setIncidentNotes(app, s.resident.id, id, { incident_notes: 'Back door' });
      const reply = await getIncidentDetails(app, s.members[0].id, id);
      expect(reply.statusCode).toBe(200);
      const body = reply.json<Body>();
      expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
      expect(body).toMatchObject({
        id,
        resident_name: 'Resident Details',
        emergency_type: 'domestic_violence',
        status: 'active',
        incident_notes: 'Back door',
        share_payload: { blood_type: 'O+' },
        share_payload_at_activation: { blood_type: 'O+' },
        share_payload_updated_at: null,
        emergency_services: GM_EMERGENCY_SERVICES,
      });
      expect(reply.body).not.toContain(s.resident.id);
      expect(reply.body).not.toContain(s.circle.id);

      await client.query('update public.incidents set share_payload = null where id = $1', [id]);
      expect(
        (await getIncidentDetails(app, s.members[0].id, id)).json<Body>().share_payload,
      ).toEqual({});
      expect(
        (await getIncidentDetails(app, s.members[0].id, id)).json<Body>()
          .share_payload_at_activation,
      ).toEqual({});
    });

    it('hidden existence: unknown, own, pre-join, removed, left, pending, outsider, no circle, legacy', async () => {
      const s = await scene(3);
      const pending = await createUser(client);
      await inviteMember(client, s.circle, { claimedBy: pending });
      const outsider = await createUser(client);
      const id = await submit(s.resident.id);
      const joiner = await lateJoiner(s);
      await callSqlAs(client, s.resident.id, 'public.remove_circle_member($1)', [
        s.memberRows[1].id,
      ]);
      await callSqlAs(client, s.members[2].id, 'public.leave_safety_circle($1)', [s.circle.id]);
      const noCircle = await insertIncident(s, {
        status: 'resolved',
        activatedAt: 'now()',
        sentAt: 'now()',
        resolvedAt: 'now()',
        circle: false,
      });
      // Legacy rows of another resident (one open alert per resident) whose circle has the viewer.
      const legacy = await scene(0);
      await addActiveMember(client, legacy.circle, s.members[0]);
      const activating = await insertIncident(legacy, {
        status: 'activating',
        activatedAt: 'now()',
      });
      const cancelled = await insertIncident(legacy, { status: 'cancelled', activatedAt: 'now()' });

      const unknown = await getIncidentDetails(
        app,
        outsider.id,
        '00000000-0000-4000-8000-0000000000bb',
      );
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).code).toBe('get_incident_details:not_found');
      const denied: [UserFixture, string][] = [
        [s.resident, id],
        [joiner, id],
        [s.members[1], id],
        [s.members[2], id],
        [pending, id],
        [outsider, id],
        [s.members[0], noCircle],
        [s.members[0], activating],
        [s.members[0], cancelled],
      ];
      for (const [caller, incidentId] of denied) {
        const reply = await getIncidentDetails(app, caller.id, incidentId);
        expect({ status: reply.statusCode, body: reply.body }).toEqual({
          status: 404,
          body: unknown.body,
        });
        const sql = await sqlOutcomeAs(client, caller.id, 'public.get_incident_details($1)', [
          incidentId,
        ]);
        expect(sql).toMatchObject({ ok: false, code: 'get_incident_details:not_found' });
      }
      expect((await getIncidentDetails(app, s.members[0].id, id)).statusCode).toBe(200);
    });

    it('rule 54 boundary: joined at the instant the incident started sees it; 1 µs later not', async () => {
      const s = await scene(0);
      const id = await submit(s.resident.id);
      const [atStart, after] = [await createUser(client), await createUser(client)];
      for (const [user, offset] of [
        [atStart, '0'],
        [after, '1 microsecond'],
      ] as const) {
        await client.query(
          `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                     invite_consumed_at, activated_at)
           select $1, 'member', 'active', 'Edge', $2, now(), i.activated_at + $4::interval
             from public.incidents i where i.id = $3`,
          [s.circle.id, user.id, id, offset],
        );
      }
      expect((await getIncidentDetails(app, atStart.id, id)).statusCode).toBe(200);
      expect((await getIncidentDetails(app, after.id, id)).statusCode).toBe(404);
      expect(await listIds(atStart.id)).toEqual([id]);
      expect(await listIds(after.id)).toEqual([]);
    });

    it('interchangeable with get_incident_details: the same JSON in the SQL shape (open, located, noted, closed)', async () => {
      const s = await scene(2);
      await client.query(
        `update public.profiles set allergies = 'Peanuts', share_allergies = true where id = $1`,
        [s.resident.id],
      );
      const id = await submit(s.resident.id);
      const compare = async () => {
        for (const member of s.members) {
          const api = await getIncidentDetails(app, member.id, id);
          const sql = await callSqlAs(client, member.id, 'public.get_incident_details($1)', [id]);
          // SCRUM-21 (D52, D53): the stored snapshot holds arrays (read by both sides): joined, and the
          // two new keys removed; the rest identical.
          expect(JSON.stringify(asSqlSharePayloadShape(api.json<Body>()))).toBe(
            JSON.stringify(asSqlSharePayloadShape(sql)),
          );
        }
      };
      await compare();
      await attachLocation(app, s.resident.id, id, {
        location_source: 'current',
        location_lat: -33.123456789,
        location_lng: 151.987654321,
        location_accuracy_m: 7.25,
        location_captured_at: new Date().toISOString(),
      });
      await setIncidentNotes(app, s.resident.id, id, { incident_notes: 'Gate code 1234' });
      await compare();
      await markSafe(app, s.resident.id, id);
      await compare();
    });
  });

  describe('races on separate connections', () => {
    async function httpDetails(userId: string, incidentId: string) {
      const response = await fetch(`${baseUrl}/v1/incidents/${incidentId}`, {
        headers: await authHeader(userId),
      });
      return { status: response.status, body: (await response.json()) as Body };
    }

    async function httpList(userId: string) {
      const response = await fetch(`${baseUrl}/v1/responder/incidents`, {
        headers: await authHeader(userId),
      });
      return { status: response.status, body: (await response.json()) as Body[] };
    }

    it('member removed while reading: 200 (read first) or not_found (removed first); never an error', async () => {
      const sqlClient = await openTestClient();
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const s = await scene(1);
          const id = await submit(s.resident.id);
          const [details, list] = await Promise.all([
            httpDetails(s.members[0].id, id),
            httpList(s.members[0].id),
            callSqlAs(sqlClient, s.resident.id, 'public.remove_circle_member($1)', [
              s.memberRows[0].id,
            ]),
          ]);
          if (details.status !== 200) {
            expect(details.status).toBe(404);
            expect(details.body.error).toMatchObject({ code: 'get_incident_details:not_found' });
          }
          expect(list.status).toBe(200);
          expect(list.body.length).toBeLessThanOrEqual(1);
          // Afterwards nothing is visible.
          expect((await httpDetails(s.members[0].id, id)).status).toBe(404);
          expect((await httpList(s.members[0].id)).body).toEqual([]);
        }
      } finally {
        await sqlClient.end();
      }
    }, 120_000);

    it('details read during a close: the active or the resolved incident, never a mix', async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(1);
        const id = await submit(s.resident.id);
        const [details] = await Promise.all([
          httpDetails(s.members[0].id, id),
          markSafe(app, s.resident.id, id),
        ]);
        expect(details.status).toBe(200);
        if (details.body.status === 'active') {
          expect(details.body).toMatchObject({
            resolved_at: null,
            location_sharing_ended_at: null,
          });
        } else {
          expect(details.body.status).toBe('resolved');
          expect(details.body.resolved_at).toBe(details.body.location_sharing_ended_at);
        }
      }
    }, 120_000);
  });
});
