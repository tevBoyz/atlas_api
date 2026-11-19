import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { DatabaseService } from '../../src/db/database.service';
import { maskActorId } from '../../src/modules/incidents/incident-actor-mask';
import {
  IncidentEventService,
  UnknownIncidentEventTypeError,
} from '../../src/modules/incidents/incident-events.service';
import {
  INCIDENT_POST_COMMIT_HOOKS,
  type IncidentEventRecordedEvent,
} from '../../src/modules/incidents/incident-post-commit';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
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
import {
  callSqlAs,
  getIncidentEvents,
  markSafe,
  markSafeViaSql,
  renotifyAlert,
  submitAlert,
  submitAlertViaSql,
} from '../support/incident-api';

/**
 * `IncidentEventService` and `GET /v1/incidents/{id}/events` (API-100-22): the one event writer
 * (`ON CONFLICT DO NOTHING` on the once-only index, unknown types refused in code), the read with
 * `incident.eventsView` (rule 54) and `recipient_ids` hidden from everyone but the resident (epic §18
 * D3, an intentional difference from the RLS policy `incident_events_select_visible`, which returns
 * the whole row), `actor_id` obscured for everyone but the resident and the actor themselves (epic
 * §18 D11, also a deliberate difference from RLS), events never rewritten, the `incident.event` post-commit hook, and reads racing a
 * close and a removal on separate connections.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof getIncidentEvents>>;

const RACE_ROUNDS = 25;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hookCalls: IncidentEventRecordedEvent[] = [];

describe('incident events (API-100-22)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app } = await createTestApp({}, (builder) =>
      withTestConfig({ DATABASE_POOL_MAX: '20' })(builder)
        .overrideProvider(INCIDENT_POST_COMMIT_HOOKS)
        .useValue([{ afterEvent: (event: IncidentEventRecordedEvent) => hookCalls.push(event) }]),
    ));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(() => {
    hookCalls.length = 0;
  });

  const errorOf = (reply: Reply) => reply.json<{ error: { code: string; details: Body } }>().error;

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    members: UserFixture[];
    memberRows: MemberFixture[];
    incidentId: string;
  }

  async function scene(count = 2): Promise<Scene> {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const members: UserFixture[] = [];
    const memberRows: MemberFixture[] = [];
    for (let i = 0; i < count; i++) {
      const user = await createUser(client);
      memberRows.push(await addActiveMember(client, circle, user));
      members.push(user);
    }
    const incidentId = (await submitAlert(app, resident.id, 'medical')).json<Body>().id as string;
    return { resident, circle, members, memberRows, incidentId };
  }

  /** The rows as stored, oldest first (`occurred_at, id`), as the database writes them as JSON. */
  async function storedEvents(incidentId: string): Promise<Body[]> {
    await client.query(`set timezone = 'UTC'`);
    const { rows } = await client.query<{ body: Body[] }>(
      `select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'event_type', e.event_type,
                'occurred_at', e.occurred_at, 'actor_id', e.actor_id, 'detail', e.detail)
                order by e.occurred_at, e.id), '[]'::jsonb) as body
         from public.incident_events e where e.incident_id = $1`,
      [incidentId],
    );
    return rows[0].body;
  }

  /** Event ids `userId` can SELECT through RLS (`incident_events_select_visible`). */
  async function rlsEventIds(userId: string, incidentId: string): Promise<string[]> {
    await client.query('begin');
    try {
      await client.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
      );
      await client.query('set local role authenticated');
      const { rows } = await client.query<{ id: string }>(
        `select id::text from public.incident_events where incident_id = $1
          order by occurred_at, id`,
        [incidentId],
      );
      return rows.map((row) => row.id);
    } finally {
      await client.query('rollback');
    }
  }

  /** What a caller who is not the resident gets: no recipient_ids (D3), actor_id masked (D11). */
  const memberView = (events: Body[], callerId: string) =>
    events.map((event) => {
      const detail = { ...(event.detail as Body) };
      delete detail.recipient_ids;
      return { ...event, actor_id: maskActorId(event.actor_id, callerId), detail };
    });

  const MASKED = /^[0-9a-f]{4}\*{4}-\*{4}-\*{4}-\*{4}-\*{8}[0-9a-f]{4}$/;

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

  describe('AC3: GET /v1/incidents/{id}/events', () => {
    it('no token: 401 incident_events:not_authenticated; bad id: 422 on field id', async () => {
      const anonymous = await app.inject({
        method: 'GET',
        url: '/v1/incidents/00000000-0000-4000-8000-000000000000/events',
      });
      expect(anonymous.statusCode).toBe(401);
      expect(errorOf(anonymous).code).toBe('incident_events:not_authenticated');
      const user = await createUser(client);
      const bad = await getIncidentEvents(app, user.id, '1234');
      expect(bad.statusCode).toBe(422);
      expect(errorOf(bad)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'id' },
      });
    });

    it('resident: every stored event, exactly 5 keys, ordered occurred_at then id, with recipient_ids', async () => {
      const s = await scene(2);
      await renotifyAlert(app, s.resident.id, s.incidentId);
      await markSafe(app, s.resident.id, s.incidentId);
      const reply = await getIncidentEvents(app, s.resident.id, s.incidentId);
      expect(reply.statusCode).toBe(200);
      const events = reply.json<Body[]>();
      expect(events).toEqual(await storedEvents(s.incidentId));
      expect(events).toHaveLength(7);
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual([
          'actor_id',
          'detail',
          'event_type',
          'id',
          'occurred_at',
        ]);
      }
      const ids = s.members.map((m) => m.id).sort();
      expect(events.find((e) => e.event_type === 'alert_sent')?.detail).toEqual({
        recipient_count: 2,
        recipient_ids: ids,
        emergency_type: 'medical',
      });
      expect(events.find((e) => e.event_type === 'closure_notified')?.detail).toEqual({
        recipient_count: 2,
        recipient_ids: ids,
      });
      expect(await rlsEventIds(s.resident.id, s.incidentId)).toEqual(events.map((e) => e.id));
    });

    it('AC4 (D3): a member gets the same events without recipient_ids; recipient_count stays', async () => {
      const s = await scene(3);
      await markSafe(app, s.resident.id, s.incidentId);
      const stored = await storedEvents(s.incidentId);
      const reply = await getIncidentEvents(app, s.members[0].id, s.incidentId);
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual(memberView(stored, s.members[0].id));
      for (const other of s.members) expect(reply.body).not.toContain(other.id);
      const alert = reply.json<Body[]>().find((e) => e.event_type === 'alert_sent');
      expect(alert?.detail).toEqual({ recipient_count: 3, emergency_type: 'medical' });
      // RLS returns the same rows (with recipient_ids): the API hides that key on purpose.
      expect(await rlsEventIds(s.members[0].id, s.incidentId)).toEqual(
        reply.json<Body[]>().map((e) => e.id),
      );
    });

    it('D11: the resident gets full actor ids; a member gets them masked, never the full UUID', async () => {
      const s = await scene(2);
      await renotifyAlert(app, s.resident.id, s.incidentId);
      await markSafe(app, s.resident.id, s.incidentId);
      const stored = await storedEvents(s.incidentId);
      expect(stored.length).toBeGreaterThan(0);
      for (const event of stored) expect(event.actor_id).toBe(s.resident.id);

      const resident = (await getIncidentEvents(app, s.resident.id, s.incidentId)).json<Body[]>();
      expect(resident.map((e) => e.actor_id)).toEqual(stored.map(() => s.resident.id));

      const reply = await getIncidentEvents(app, s.members[0].id, s.incidentId);
      expect(reply.statusCode).toBe(200);
      const member = reply.json<Body[]>();
      // Same rows in the same order as the stored log and as RLS (which returns the full actor_id).
      expect(member.map((e) => e.id)).toEqual(stored.map((e) => e.id));
      expect(await rlsEventIds(s.members[0].id, s.incidentId)).toEqual(member.map((e) => e.id));
      for (const event of member) {
        const actor = event.actor_id as string;
        expect(actor).toMatch(MASKED);
        expect(actor).toHaveLength(36);
        expect(actor.slice(0, 4)).toBe(s.resident.id.slice(0, 4));
        expect(actor.slice(-4)).toBe(s.resident.id.slice(-4));
      }
      expect(reply.body).not.toContain(s.resident.id);
      expect(reply.body.toLowerCase()).not.toContain(s.resident.id.toLowerCase());
    });

    it('D11: an actor who is the caller is shown in full; a null actor stays null', async () => {
      const s = await scene(1);
      const [mine] = await client
        .query<{ id: string }>(
          `insert into public.incident_events (incident_id, event_type, actor_id, detail)
           values ($1, 'renotified', $2, '{"recipient_count": 1}'::jsonb),
                  ($1, 'renotified', null, '{"recipient_count": 1}'::jsonb)
           returning id::text`,
          [s.incidentId, s.members[0].id],
        )
        .then((result) => result.rows);
      const member = (await getIncidentEvents(app, s.members[0].id, s.incidentId)).json<Body[]>();
      expect(member.find((e) => e.id === mine.id)?.actor_id).toBe(s.members[0].id);
      expect(member.filter((e) => e.actor_id === null)).toHaveLength(1);
      for (const event of member.filter((e) => e.id !== mine.id && e.actor_id !== null)) {
        expect(event.actor_id).toMatch(MASKED);
      }
      expect(member).toEqual(memberView(await storedEvents(s.incidentId), s.members[0].id));
    });

    it('rule 54 and hidden existence: every denied caller gets the body of an unknown id', async () => {
      const s = await scene(3);
      const joiner = await lateJoiner(s);
      const pending = await createUser(client);
      await inviteMember(client, s.circle, { claimedBy: pending });
      const outsider = await createUser(client);
      await callSqlAs(client, s.resident.id, 'public.remove_circle_member($1)', [
        s.memberRows[1].id,
      ]);
      await callSqlAs(client, s.members[2].id, 'public.leave_safety_circle($1)', [s.circle.id]);
      const unknown = await getIncidentEvents(app, outsider.id, randomUUID());
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).code).toBe('incident_events:not_found');
      for (const caller of [joiner, pending, outsider, s.members[1], s.members[2]]) {
        const reply = await getIncidentEvents(app, caller.id, s.incidentId);
        expect({ status: reply.statusCode, body: reply.body }).toEqual({
          status: 404,
          body: unknown.body,
        });
        expect(await rlsEventIds(caller.id, s.incidentId)).toEqual([]);
      }
      expect((await getIncidentEvents(app, s.members[0].id, s.incidentId)).statusCode).toBe(200);
    });

    it('legacy statuses: the resident still reads them; members get not_found (as RLS)', async () => {
      const s = await scene(1);
      await client.query(
        `update public.incidents set status = 'activating', sent_at = null where id = $1`,
        [s.incidentId],
      );
      expect((await getIncidentEvents(app, s.resident.id, s.incidentId)).statusCode).toBe(200);
      const member = await getIncidentEvents(app, s.members[0].id, s.incidentId);
      expect(errorOf(member).code).toBe('incident_events:not_found');
      expect(await rlsEventIds(s.members[0].id, s.incidentId)).toEqual([]);
    });

    it('an incident with no events yet (pre-events legacy row) is [] for the resident, not 404', async () => {
      const resident = await createUser(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into public.incidents (resident_id, status, emergency_type, sent_at)
         values ($1, 'active', 'fire', now()) returning id`,
        [resident.id],
      );
      const reply = await getIncidentEvents(app, resident.id, rows[0].id);
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual([]);
    });

    it('events written by the SQL functions read the same as events written by the API', async () => {
      const [a, b] = [await scene(2), await scene(2)];
      // b was opened through the API; re-open both sides with the other writer.
      await markSafe(app, a.resident.id, a.incidentId);
      await markSafeViaSql(client, b.resident.id, b.incidentId);
      const sqlSide = await submitAlertViaSql(client, a.resident.id, 'fire');
      const shape = (events: Body[]) =>
        events.map((e) => ({
          event_type: e.event_type,
          by_resident: true,
          detail_keys: Object.keys(e.detail as Body).sort(),
        }));
      const viaApi = (await getIncidentEvents(app, a.members[0].id, a.incidentId)).json<Body[]>();
      const viaSql = (await getIncidentEvents(app, b.members[0].id, b.incidentId)).json<Body[]>();
      expect(
        shape(viaApi).sort((x, y) => String(x.event_type).localeCompare(String(y.event_type))),
      ).toEqual(
        shape(viaSql).sort((x, y) => String(x.event_type).localeCompare(String(y.event_type))),
      );
      const fresh = (await getIncidentEvents(app, a.members[0].id, sqlSide.id as string)).json<
        Body[]
      >();
      expect(fresh.map((e) => e.event_type).sort()).toEqual([
        'alert_sent',
        'location_sharing_started',
      ]);
    });
  });

  describe('AC1, AC2, AC5: the writer', () => {
    it('once-only types are a no-op on repeat (the unique index); renotified repeats; unknown refused', async () => {
      const s = await scene(1);
      const events = app.get(IncidentEventService);
      const database = app.get(DatabaseService);
      const before = await storedEvents(s.incidentId);
      const outcome = await database.db.transaction(async (tx) => ({
        alert: await events.record(tx, s.incidentId, 'alert_sent', s.resident.id, {
          recipient_count: 99,
        }),
        renotified1: await events.record(tx, s.incidentId, 'renotified', s.resident.id, {
          recipient_count: 1,
        }),
        renotified2: await events.record(tx, s.incidentId, 'renotified', s.resident.id, {
          recipient_count: 1,
        }),
        drained: events.drain(tx),
      }));
      expect(outcome.alert).toBeUndefined();
      expect(outcome.renotified1?.event_type).toBe('renotified');
      expect(outcome.renotified2?.id).not.toBe(outcome.renotified1?.id);
      expect(outcome.drained.map((e) => e.event_type)).toEqual(['renotified', 'renotified']);
      const after = await storedEvents(s.incidentId);
      expect(after.filter((e) => e.event_type !== 'renotified')).toEqual(before);
      expect(after.filter((e) => e.event_type === 'renotified')).toHaveLength(2);

      await expect(
        database.db.transaction((tx) =>
          events.record(tx, s.incidentId, 'arrived' as never, s.resident.id),
        ),
      ).rejects.toBeInstanceOf(UnknownIncidentEventTypeError);
      expect(await storedEvents(s.incidentId)).toEqual(after);
    });

    it('AC5: a full lifecycle never rewrites or removes an earlier event', async () => {
      const s = await scene(2);
      const opened = await storedEvents(s.incidentId);
      await submitAlert(app, s.resident.id, 'fire');
      await renotifyAlert(app, s.resident.id, s.incidentId);
      const renotified = await storedEvents(s.incidentId);
      expect(renotified.slice(0, opened.length)).toEqual(opened);
      await markSafe(app, s.resident.id, s.incidentId);
      await markSafe(app, s.resident.id, s.incidentId);
      const closed = await storedEvents(s.incidentId);
      for (const event of renotified) expect(closed).toContainEqual(event);
      expect(closed).toHaveLength(renotified.length + 4);
    });
  });

  describe('AC6: post-commit hook incident.event', () => {
    // Only this test's incident: hooks of earlier tests may still be arriving.
    let incidentOfTest = '';
    const mine = () => hookCalls.filter((event) => event.incident_id === incidentOfTest);

    const waitForHooks = async (count: number) => {
      const deadline = Date.now() + 5_000;
      while (mine().length < count && Date.now() < deadline) await sleep(5);
      await sleep(30);
    };

    it('one call per inserted event, in insertion order, ids only; none for no-ops or replays', async () => {
      const s = await scene(1);
      incidentOfTest = s.incidentId;
      await waitForHooks(2);
      // Events of one transaction share occurred_at, so the stored order (occurred_at, id) is not
      // insertion order; compare as a set, then check the insertion order by type.
      expect(mine()).toHaveLength(2);
      expect(mine()).toEqual(
        expect.arrayContaining(
          (await storedEvents(s.incidentId)).map((e) => ({
            incident_id: s.incidentId,
            resident_id: s.resident.id,
            circle_id: s.circle.id,
            event_id: e.id,
            event_type: e.event_type,
          })),
        ),
      );
      expect(mine().map((e) => e.event_type)).toEqual(['alert_sent', 'location_sharing_started']);

      hookCalls.length = 0;
      await renotifyAlert(app, s.resident.id, s.incidentId);
      await waitForHooks(1);
      expect(mine().map((e) => e.event_type)).toEqual(['renotified']);

      hookCalls.length = 0;
      const key = randomUUID();
      await markSafe(app, s.resident.id, s.incidentId, key);
      await waitForHooks(4);
      expect(mine().map((e) => e.event_type)).toEqual([
        'safe_recorded',
        'incident_closed',
        'location_sharing_ended',
        'closure_notified',
      ]);

      hookCalls.length = 0;
      await markSafe(app, s.resident.id, s.incidentId, key);
      await markSafe(app, s.resident.id, s.incidentId);
      await sleep(80);
      expect(mine()).toEqual([]);
    });
  });

  describe('races on separate connections', () => {
    async function httpEvents(userId: string, incidentId: string) {
      const response = await fetch(`${baseUrl}/v1/incidents/${incidentId}/events`, {
        headers: await authHeader(userId),
      });
      return { status: response.status, body: (await response.json()) as Body };
    }

    it('events read during a close: the open log or the closed log, never half a close', async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(1);
        const reader = round % 2 === 0 ? s.resident.id : s.members[0].id;
        const [read] = await Promise.all([
          httpEvents(reader, s.incidentId),
          markSafe(app, s.resident.id, s.incidentId),
        ]);
        expect(read.status).toBe(200);
        const types = (read.body as unknown as Body[]).map((e) => e.event_type);
        expect([2, 6]).toContain(types.length);
      }
    }, 120_000);

    it('member removed while reading events: 200 or not_found, never an error', async () => {
      const sqlClient = await openTestClient();
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const s = await scene(1);
          const [read] = await Promise.all([
            httpEvents(s.members[0].id, s.incidentId),
            callSqlAs(sqlClient, s.resident.id, 'public.remove_circle_member($1)', [
              s.memberRows[0].id,
            ]),
          ]);
          if (read.status !== 200) {
            expect(read.status).toBe(404);
            expect(read.body.error).toMatchObject({ code: 'incident_events:not_found' });
          }
          expect((await httpEvents(s.members[0].id, s.incidentId)).status).toBe(404);
        }
      } finally {
        await sqlClient.end();
      }
    }, 120_000);
  });
});
