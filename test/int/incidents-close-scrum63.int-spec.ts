import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { Client } from 'pg';

import { JobQueues } from '../../src/jobs/job-queues.service';
import { JobWorkers } from '../../src/jobs/job-workers';
import {
  INCIDENT_CLOSE_SWEEP_EVERY_MS,
  INCIDENT_CLOSE_SWEEP_SCHEDULER_ID,
  INCIDENT_LIFECYCLE_QUEUE,
} from '../../src/jobs/jobs.constants';
import { IncidentCloseSweeper } from '../../src/modules/incidents/incident-close-sweeper';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { WorkerRealtimeEmitter } from '../../src/realtime/worker-realtime-emitter';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { createTestWorker } from '../../src/testing/test-worker';
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
  attachLocation,
  countRows,
  getIncidentDetails,
  getIncidentEvents,
  getOpenIncident,
  listRecentIncidents,
  listResponderIncidents,
  markSafe,
  renotifyAlert,
  setIncidentNotes,
  submitAlert,
} from '../support/incident-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * SCRUM-63 (Incident Resolution Status), decisions D61 (states and transitions) and D62 (the close
 * sweeper, its settings and events): migration 0017, Active -> Resolved (Safe) -> Closed and
 * Active -> Closed (automatic, after inactivity), the refused actions on a closed incident, the
 * reads carrying the state, events, audit, no notification at the close, the `incident.closed`
 * broadcast from the worker process, idempotency and races on separate connections (two sweeps,
 * mark safe, location pings: never a 40P01).
 */
type Body = Record<string, unknown>;

const UTC_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const A_UTC: unknown = expect.stringMatching(UTC_TEXT);
const RACE_ROUNDS = 15;

describe('incident resolution status (SCRUM-63, D61/D62)', () => {
  let app: NestFastifyApplication;
  let url: string;
  let client: Client;
  let worker: TestingModule;
  let sweeper: IncidentCloseSweeper;
  const open: TestSocket[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig({ DATABASE_POOL_MAX: '20' })));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    client = await openTestClient();
    // The real worker module, without the BullMQ workers: the tests run the sweep themselves, so no
    // scheduled run can interleave with an assertion.
    ({ worker } = await createTestWorker((builder) =>
      builder.overrideProvider(JobWorkers).useValue({}),
    ));
    sweeper = worker.get(IncidentCloseSweeper);
    await eventually(async () => {
      await app.get(RealtimeGateway).ping();
      await worker.get(WorkerRealtimeEmitter).ping();
    });
  });

  afterEach(async () => {
    for (const socket of open.splice(0)) socket.close();
    await setConfig(30, 24);
  });

  afterAll(async () => {
    await client.end();
    await worker.close();
    await app.close();
  });

  async function setConfig(minutes: unknown, hours: unknown) {
    for (const [key, value] of [
      ['incident_close_after_minutes', minutes],
      ['incident_auto_close_after_hours', hours],
    ] as const) {
      if (value === undefined) {
        await client.query('delete from public.app_config where key = $1', [key]);
      } else {
        await client.query(
          `insert into public.app_config (key, value) values ($1, $2::jsonb)
           on conflict (key) do update set value = excluded.value`,
          [key, JSON.stringify(value)],
        );
      }
    }
  }

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    members: UserFixture[];
    incidentId: string;
  }

  async function scene(count = 2): Promise<Scene> {
    const resident = await createUser(client, { fullName: 'Rita Resident' });
    const circle = await createCircle(client, resident);
    const members: UserFixture[] = [];
    for (let i = 0; i < count; i++) {
      const user = await createUser(client, { fullName: `Member ${i}` });
      await addActiveMember(client, circle, user);
      members.push(user);
    }
    const reply = await submitAlert(app, resident.id, 'medical');
    expect(reply.statusCode).toBe(201);
    return { resident, circle, members, incidentId: reply.json<Body>().id as string };
  }

  /**
   * Moves an incident (and its circle's memberships, so the members stay inside the window) `hours`
   * into the past, without the updated_at trigger: an alert left alone that long.
   */
  async function age(s: Scene, hours: number) {
    await client.query('begin');
    try {
      await client.query('set local session_replication_role = replica');
      await client.query(
        `update public.incidents
            set activated_at = activated_at - make_interval(hours => $2),
                sent_at = sent_at - make_interval(hours => $2),
                updated_at = updated_at - make_interval(hours => $2),
                renotified_at = renotified_at - make_interval(hours => $2),
                incident_notes_updated_at = incident_notes_updated_at - make_interval(hours => $2)
          where id = $1`,
        [s.incidentId, hours],
      );
      await client.query(
        `update public.incident_deliveries
            set delivered_at = delivered_at - make_interval(hours => $2),
                acknowledged_at = acknowledged_at - make_interval(hours => $2),
                response_at = response_at - make_interval(hours => $2)
          where incident_id = $1`,
        [s.incidentId, hours],
      );
      await client.query(
        `update public.safety_circle_members
            set activated_at = activated_at - make_interval(hours => $2)
          where circle_id = $1 and activated_at is not null`,
        [s.circle.id, hours],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  }

  /** Moves `resolved_at` `minutes` into the past (the wrap-up period passing). */
  async function ageResolved(incidentId: string, minutes: number) {
    await client.query(
      `update public.incidents set resolved_at = resolved_at - make_interval(mins => $2)
        where id = $1`,
      [incidentId, minutes],
    );
  }

  async function row(incidentId: string) {
    const { rows } = await client.query<Body>(
      `select status, resolved_reason, auto_closed,
              to_jsonb(resolved_at) #>> '{}' as resolved_at,
              to_jsonb(closed_at) #>> '{}' as closed_at,
              location_sharing_ended_at is not null as sharing_ended
         from public.incidents where id = $1`,
      [incidentId],
    );
    return rows[0];
  }

  async function events(incidentId: string) {
    const { rows } = await client.query<{
      event_type: string;
      actor_id: string | null;
      detail: Body;
    }>(
      `select event_type, actor_id::text as actor_id, detail from public.incident_events
        where incident_id = $1 order by occurred_at, id`,
      [incidentId],
    );
    return rows;
  }

  const outboxRows = (incidentId: string) =>
    countRows(
      client,
      'select count(*)::int as n from public.notification_outbox where aggregate_id = $1',
      [incidentId],
    );

  async function respond(userId: string, incidentId: string, status: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/incidents/${incidentId}/response`,
      headers: { ...(await authHeader(userId)), 'content-type': 'application/json' },
      payload: JSON.stringify({ status }),
    });
  }

  async function responders(userId: string, incidentId: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/incidents/${incidentId}/responders`,
      headers: await authHeader(userId),
    });
  }

  const ping = (userId: string, incidentId: string) =>
    attachLocation(app, userId, incidentId, {
      location_source: 'current',
      location_lat: 13.45,
      location_lng: -16.58,
      location_accuracy_m: 8,
      location_captured_at: new Date().toISOString(),
    });

  describe('migration 0017', () => {
    it('seeds the two settings as whole numbers (30 minutes, 24 hours)', async () => {
      await client.query(
        `insert into public.app_config (key, value) values
           ('incident_close_after_minutes', '30'::jsonb),
           ('incident_auto_close_after_hours', '24'::jsonb)
         on conflict (key) do update set value = excluded.value`,
      );
      const { rows } = await client.query<{ key: string; value: unknown }>(
        `select key, value from public.app_config
          where key in ('incident_close_after_minutes', 'incident_auto_close_after_hours')
          order by key`,
      );
      expect(rows).toEqual([
        { key: 'incident_auto_close_after_hours', value: 24 },
        { key: 'incident_close_after_minutes', value: 30 },
      ]);
    });

    it('closed needs closed_at and a reason safe/ended; closed_at only on closed', async () => {
      const s = await scene(0);
      const fails = async (statement: string) => {
        await client.query('savepoint s');
        await expect(client.query(statement, [s.incidentId])).rejects.toMatchObject({
          code: '23514',
        });
        await client.query('rollback to savepoint s');
      };
      await client.query('begin');
      try {
        await fails(`update public.incidents set status = 'closed' where id = $1`);
        await fails(
          `update public.incidents set status = 'closed', closed_at = now(), resolved_at = now()
            where id = $1`,
        );
        await fails(`update public.incidents set closed_at = now() where id = $1`);
        await fails(`update public.incidents set status = 'gone' where id = $1`);
        await client.query(
          `update public.incidents
              set status = 'closed', closed_at = now(), resolved_at = now(),
                  resolved_reason = 'ended', auto_closed = true,
                  location_sharing_ended_at = now()
            where id = $1`,
          [s.incidentId],
        );
      } finally {
        await client.query('rollback');
      }
    });
  });

  describe('Active -> Resolved (Safe) -> Closed', () => {
    it('mark safe: Resolved with safe_recorded but no incident_closed; the push is unchanged', async () => {
      const s = await scene();
      const safe = await markSafe(app, s.resident.id, s.incidentId);
      expect(safe.statusCode).toBe(200);
      expect(safe.json<Body>()).toMatchObject({
        status: 'resolved',
        resolved_reason: 'safe',
        auto_closed: false,
      });
      // Events of one transaction share occurred_at: compared as a set.
      expect((await events(s.incidentId)).map((e) => e.event_type).sort()).toEqual([
        'alert_sent',
        'closure_notified',
        'location_sharing_ended',
        'location_sharing_started',
        'safe_recorded',
      ]);
      // The "Marked safe" notice is still enqueued at mark safe (created + resolved).
      expect(await outboxRows(s.incidentId)).toBe(2);
    });

    it('stays Resolved during the wrap-up, closes after it: incident_closed {safe}, audit, no notice', async () => {
      const s = await scene();
      await markSafe(app, s.resident.id, s.incidentId);
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('resolved');

      await ageResolved(s.incidentId, 31);
      const auditBefore = await countRows(
        client,
        `select count(*)::int as n from public.audit_log
          where action = 'incident.closed' and target_id = $1`,
        [s.incidentId],
      );
      expect(auditBefore).toBe(0);
      await sweeper.sweep();

      const closed = await row(s.incidentId);
      expect(closed).toMatchObject({
        status: 'closed',
        resolved_reason: 'safe',
        auto_closed: false,
        sharing_ended: true,
      });
      expect(closed.closed_at).toEqual(expect.any(String));
      const closedEvents = (await events(s.incidentId)).filter(
        (e) => e.event_type === 'incident_closed',
      );
      expect(closedEvents).toHaveLength(1);
      expect(closedEvents[0]).toEqual({
        event_type: 'incident_closed',
        actor_id: null,
        detail: { reason: 'safe', auto_closed: false },
      });
      const { rows } = await client.query<Body>(
        `select actor_user_id, target_type, detail from public.audit_log
          where action = 'incident.closed' and target_id = $1`,
        [s.incidentId],
      );
      expect(rows).toEqual([
        {
          actor_user_id: null,
          target_type: 'incident',
          detail: {
            resident_id: s.resident.id,
            circle_id: s.circle.id,
            reason: 'safe',
            auto_closed: false,
            previous_status: 'resolved',
          },
        },
      ]);
      // No push, SMS or email at Closed: no new outbox row.
      expect(await outboxRows(s.incidentId)).toBe(2);
    });

    it('the wrap-up follows app_config (minutes); a bad value falls back to 30', async () => {
      const s = await scene(0);
      await markSafe(app, s.resident.id, s.incidentId);
      await ageResolved(s.incidentId, 3);
      await setConfig('5', 24); // a JSON string is not a number: 30
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('resolved');
      await setConfig(0, 24); // <= 0: 30
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('resolved');
      await setConfig(undefined, undefined); // missing: 30
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('resolved');
      await setConfig(2, 24);
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('closed');
    });
  });

  describe('Active -> Closed (automatically, after inactivity)', () => {
    it('closes an alert left alone: ended, auto_closed, sharing ended, events, audit, no notice', async () => {
      const s = await scene();
      await age(s, 25);
      await sweeper.sweep();
      const closed = await row(s.incidentId);
      expect(closed).toMatchObject({
        status: 'closed',
        resolved_reason: 'ended',
        auto_closed: true,
        sharing_ended: true,
      });
      expect(closed.resolved_at).toBe(closed.closed_at);
      const byType = (a: { event_type: string }, b: { event_type: string }) =>
        a.event_type.localeCompare(b.event_type);
      expect(
        (await events(s.incidentId)).sort(byType).map((e) => [e.event_type, e.actor_id, e.detail]),
      ).toEqual([
        ['alert_sent', s.resident.id, expect.any(Object)],
        ['incident_closed', null, { reason: 'ended', auto_closed: true }],
        ['location_sharing_ended', null, {}],
        ['location_sharing_started', s.resident.id, {}],
      ]);
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.audit_log
            where action = 'incident.closed' and target_id = $1
              and detail = jsonb_build_object('resident_id', $2::text, 'circle_id', $3::text,
                                              'reason', 'ended', 'auto_closed', true,
                                              'previous_status', 'active')`,
          [s.incidentId, s.resident.id, s.circle.id],
        ),
      ).toBe(1);
      expect(await outboxRows(s.incidentId)).toBe(1); // the alert only
    });

    it('not before the inactivity period (24 h by default; app_config hours)', async () => {
      const s = await scene(0);
      await age(s, 5);
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('active');
      await setConfig(30, 4);
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('closed');
    });

    it.each([
      ['a location ping', (s: Scene) => ping(s.resident.id, s.incidentId)],
      [
        'a note',
        (s: Scene) => setIncidentNotes(app, s.resident.id, s.incidentId, { incident_notes: 'x' }),
      ],
      ['a re-notify', (s: Scene) => renotifyAlert(app, s.resident.id, s.incidentId)],
      ['an acknowledge', (s: Scene) => acknowledgeIncident(app, s.members[0].id, s.incidentId)],
      ['a response', (s: Scene) => respond(s.members[0].id, s.incidentId, 'responding')],
    ])('activity keeps it open: %s', async (_name, act) => {
      const s = await scene(1);
      await age(s, 25);
      expect((await act(s)).statusCode).toBe(200);
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('active');
    });
  });

  describe('a closed incident is final and read-only', () => {
    async function closedScene() {
      const s = await scene(2);
      await acknowledgeIncident(app, s.members[0].id, s.incidentId);
      await respond(s.members[1].id, s.incidentId, 'unable');
      await age(s, 25);
      await sweeper.sweep();
      expect((await row(s.incidentId)).status).toBe('closed');
      return s;
    }

    it('refuses renotify, notes, location, acknowledge, response and mark safe (409, no write)', async () => {
      const s = await closedScene();
      const before = await events(s.incidentId);
      const refused: [string, { statusCode: number; json: <T>() => T }][] = [
        [
          'renotify_emergency_alert:not_open',
          await renotifyAlert(app, s.resident.id, s.incidentId),
        ],
        [
          'set_incident_notes:not_open',
          await setIncidentNotes(app, s.resident.id, s.incidentId, { incident_notes: 'late' }),
        ],
        ['attach_incident_location:not_open', await ping(s.resident.id, s.incidentId)],
        [
          'acknowledge_incident:not_open',
          await acknowledgeIncident(app, s.members[1].id, s.incidentId),
        ],
        ['incident_response:not_open', await respond(s.members[0].id, s.incidentId, 'unable')],
        ['mark_incident_safe:not_open', await markSafe(app, s.resident.id, s.incidentId)],
      ];
      for (const [code, reply] of refused) {
        expect([code, reply.statusCode]).toEqual([code, 409]);
        expect(reply.json<{ error: { code: string } }>().error.code).toBe(code);
      }
      expect(await events(s.incidentId)).toEqual(before);
      expect((await row(s.incidentId)).status).toBe('closed');
    });

    it('a Resolved (Safe) incident that closed refuses mark safe too', async () => {
      const s = await scene(0);
      await markSafe(app, s.resident.id, s.incidentId);
      await ageResolved(s.incidentId, 31);
      await sweeper.sweep();
      const again = await markSafe(app, s.resident.id, s.incidentId);
      expect(again.statusCode).toBe(409);
      expect(again.json<{ error: { code: string } }>().error.code).toBe(
        'mark_incident_safe:not_open',
      );
    });

    it('every read carries the state; responders and history stay readable', async () => {
      const s = await closedScene();
      const recent = (await listRecentIncidents(app, s.resident.id)).json<Body[]>();
      expect(recent[0]).toMatchObject({
        id: s.incidentId,
        status: 'closed',
        resolved_reason: 'ended',
        auto_closed: true,
        closed_at: A_UTC,
        resolved_at: A_UTC,
      });
      const list = (await listResponderIncidents(app, s.members[0].id)).json<Body[]>();
      expect(list.find((i) => i.id === s.incidentId)).toMatchObject({
        status: 'closed',
        resolved_reason: 'ended',
        auto_closed: true,
        closed_at: A_UTC,
      });
      const details = await getIncidentDetails(app, s.members[0].id, s.incidentId);
      expect(details.statusCode).toBe(200);
      expect(details.json<Body>()).toMatchObject({
        status: 'closed',
        closed_at: A_UTC,
        auto_closed: true,
      });
      const who = await responders(s.members[1].id, s.incidentId);
      expect(who.statusCode).toBe(200);
      expect(who.json<Body[]>().map((r) => r.status)).toEqual(['acknowledged', 'unable']);
      expect((await responders(s.resident.id, s.incidentId)).statusCode).toBe(200);
      const history = await getIncidentEvents(app, s.members[0].id, s.incidentId);
      expect(history.statusCode).toBe(200);
      expect(history.json<Body[]>().map((e) => e.event_type)).toContain('incident_closed');
      // Not open any more: no open incident, and a new SOS is a new incident.
      expect((await getOpenIncident(app, s.resident.id)).json<Body>()).toEqual({
        open_incident: null,
      });
      const next = await submitAlert(app, s.resident.id, 'fire');
      expect(next.statusCode).toBe(201);
      expect(next.json<Body>()).toMatchObject({ submit_outcome: 'created', status: 'active' });
    });

    it('a new SOS is allowed while the last one is Resolved (Safe)', async () => {
      const s = await scene(0);
      await markSafe(app, s.resident.id, s.incidentId);
      const next = await submitAlert(app, s.resident.id, 'fire');
      expect(next.statusCode).toBe(201);
      expect(next.json<Body>().id).not.toBe(s.incidentId);
    });

    it('an outsider still sees nothing', async () => {
      const s = await closedScene();
      const outsider = await createUser(client);
      expect((await getIncidentDetails(app, outsider.id, s.incidentId)).statusCode).toBe(404);
      expect((await responders(outsider.id, s.incidentId)).statusCode).toBe(404);
    });
  });

  describe('idempotency and races', () => {
    it('a second sweep closes nothing more and writes nothing', async () => {
      const s = await scene(0);
      await age(s, 25);
      await sweeper.sweep();
      const after = await events(s.incidentId);
      const second = await sweeper.sweep();
      expect(second.map((c) => c.id)).not.toContain(s.incidentId);
      expect(await events(s.incidentId)).toEqual(after);
    });

    it('two sweeps at once (two workers): each incident closed once, no error', async () => {
      const scenes: Scene[] = [];
      for (let i = 0; i < 6; i++) scenes.push(await scene(0));
      for (const s of scenes) await age(s, 25);
      const other = await createTestWorker((builder) =>
        builder.overrideProvider(JobWorkers).useValue({}),
      );
      try {
        const [a, b] = await Promise.all([
          sweeper.sweep(),
          other.worker.get(IncidentCloseSweeper).sweep(),
        ]);
        const ids = [...a, ...b]
          .map((c) => c.id)
          .filter((id) => scenes.some((s) => s.incidentId === id));
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(scenes.length);
      } finally {
        await other.worker.close();
      }
      for (const s of scenes) {
        expect((await row(s.incidentId)).status).toBe('closed');
        expect(
          (await events(s.incidentId)).filter((e) => e.event_type === 'incident_closed'),
        ).toHaveLength(1);
      }
    });

    it('auto-close racing mark safe: one of the two wins, never a deadlock or a mixed row', async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(1);
        await age(s, 25);
        const [safe] = await Promise.all([
          markSafe(app, s.resident.id, s.incidentId),
          sweeper.sweep(),
        ]);
        const final = await row(s.incidentId);
        if (safe.statusCode === 200) {
          // Mark safe won (the sweeper skipped or found it resolved, not yet due).
          expect(final).toMatchObject({ status: 'resolved', resolved_reason: 'safe' });
        } else {
          expect(safe.statusCode).toBe(409);
          expect(final).toMatchObject({
            status: 'closed',
            resolved_reason: 'ended',
            auto_closed: true,
          });
        }
        const types = (await events(s.incidentId)).map((e) => e.event_type);
        expect(types.filter((t) => t === 'location_sharing_ended')).toHaveLength(1);
      }
    });

    it('auto-close racing location pings: never a deadlock; a ping either lands first or is refused', async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(0);
        await age(s, 25);
        const [first, , second] = await Promise.all([
          ping(s.resident.id, s.incidentId),
          sweeper.sweep(),
          ping(s.resident.id, s.incidentId),
        ]);
        for (const reply of [first, second]) expect([200, 409]).toContain(reply.statusCode);
        const final = await row(s.incidentId);
        if (final.status === 'closed') {
          // A ping that landed after the close is refused (not_open), never stored.
          expect(final).toMatchObject({ resolved_reason: 'ended', sharing_ended: true });
        } else {
          expect(final.status).toBe('active');
          expect([first.statusCode, second.statusCode]).toContain(200);
        }
      }
    });
  });

  describe('incident.closed (realtime, from the worker process)', () => {
    it('reaches a member and the resident who are not in the room, and the room, once each', async () => {
      const s = await scene(2);
      const resident = await connectSocket(url, s.resident.id);
      const watcher = await connectSocket(url, s.members[0].id);
      const away = await connectSocket(url, s.members[1].id);
      const outsider = await connectSocket(url, (await createUser(client)).id);
      open.push(resident, watcher, away, outsider);
      await sleep(200);
      await expect(watcher.join(s.incidentId)).resolves.toEqual({ ok: true });
      await age(s, 25);
      await sweeper.sweep();

      const expected = {
        incident_id: s.incidentId,
        status: 'closed',
        closed_at: A_UTC,
        resolved_reason: 'ended',
        auto_closed: true,
        occurred_at: A_UTC,
      };
      for (const socket of [resident, watcher, away]) {
        const payload = await socket.next('incident.closed');
        expect(payload).toEqual(expected);
        expect(Object.keys(payload)).toEqual([
          'incident_id',
          'status',
          'closed_at',
          'resolved_reason',
          'auto_closed',
          'occurred_at',
        ]);
      }
      // The room also gets the merged row and the two events.
      const updated = await watcher.next<{ incident: Body }>('incident.updated');
      expect(updated.incident).toMatchObject({ status: 'closed', auto_closed: true });
      await eventually(() => {
        expect(
          watcher.of<{ event: Body }>('incident.event').map((e) => e.event.event_type),
        ).toEqual(['location_sharing_ended', 'incident_closed']);
      });
      await sleep(300);
      for (const socket of [resident, watcher, away]) {
        expect(socket.of('incident.closed')).toHaveLength(1);
      }
      expect(outsider.received).toEqual([]);
    });

    it('Resolved -> Closed: reason safe, auto_closed false', async () => {
      const s = await scene(1);
      const member = await connectSocket(url, s.members[0].id);
      open.push(member);
      await markSafe(app, s.resident.id, s.incidentId);
      await ageResolved(s.incidentId, 31);
      await sweeper.sweep();
      expect(await member.next('incident.closed')).toMatchObject({
        status: 'closed',
        resolved_reason: 'safe',
        auto_closed: false,
      });
    });
  });

  describe('the worker schedules ONE repeatable sweep', () => {
    it('incident-close-sweep, every minute, on incident-lifecycle; re-registering keeps one', async () => {
      const queue = worker.get(JobQueues).queue(INCIDENT_LIFECYCLE_QUEUE);
      await sweeper.schedule();
      await sweeper.schedule();
      await eventually(async () => {
        const schedulers = await queue.getJobSchedulers();
        expect(schedulers).toHaveLength(1);
        expect(schedulers[0]).toMatchObject({
          key: INCIDENT_CLOSE_SWEEP_SCHEDULER_ID,
          every: INCIDENT_CLOSE_SWEEP_EVERY_MS,
        });
      });
    });
  });
});
