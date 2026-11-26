import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { IncidentBroadcaster } from '../../src/realtime/incident-broadcaster';
import { RealtimeReadsRepository } from '../../src/realtime/realtime-reads.repository';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp, type LogCapture } from '../../src/testing/test-app';
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
  getDeliveryCounts,
  getIncidentDetails,
  getIncidentEvents,
  getOpenIncident,
  markSafe,
  renotifyAlert,
  setIncidentNotes,
  submitAlert,
} from '../support/incident-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * Incident broadcasts (API-100-41) across two API instances: every write's events reach the room
 * after the commit with the REST privacy rules per receiver (D3, D11), the counts reach only the
 * resident, payloads carry `incident_id`, `occurred_at` and `updated_at`, and a failed broadcast never
 * fails the request.
 */
type Body = Record<string, unknown>;

/** The keys of `incident.updated.incident` (spec §11.5): 16 plus closed_at (SCRUM-63) and location_unavailable_since (D74), never resident_id / circle_id. */
const UPDATED_KEYS = [
  'auto_closed',
  'closed_at',
  'emergency_type',
  'incident_notes',
  'incident_notes_updated_at',
  'location_accuracy_m',
  'location_captured_at',
  'location_lat',
  'location_lng',
  'location_sharing_ended_at',
  'location_source',
  'location_unavailable_since', // SCRUM-68 (D74)
  'renotified_at',
  'resolved_at',
  'resolved_reason',
  'sent_at',
  'share_payload',
  'status',
];

const MASKED = /^[0-9a-f]{4}\*{4}-\*{4}-\*{4}-\*{4}-\*{8}[0-9a-f]{4}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const A_TIMESTAMP: unknown = expect.stringMatching(TIMESTAMP);

describe('incident broadcasts (API-100-41)', () => {
  let appA: NestFastifyApplication;
  let appB: NestFastifyApplication;
  let logsA: LogCapture;
  let urlA: string;
  let urlB: string;
  let client: Client;
  const open: TestSocket[] = [];
  /** Per incident: how many `incident.event` broadcasts the submitting instance (B) has finished. */
  const eventBroadcastsDone = new Map<string, number>();

  async function connect(url: string, user: UserFixture) {
    const socket = await connectSocket(url, user.id);
    open.push(socket);
    return socket;
  }

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    m1: UserFixture;
    m2: UserFixture;
    outsider: UserFixture;
    r: TestSocket;
    s1: TestSocket;
    s2: TestSocket;
    out: TestSocket;
    incidentId: string;
  }

  /** A resident with two members, all connected (members on both instances), and a submitted SOS. */
  async function scene(): Promise<Scene> {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const m1 = await createUser(client);
    const m2 = await createUser(client);
    await addActiveMember(client, circle, m1);
    await addActiveMember(client, circle, m2);
    const outsider = await createUser(client);
    const r = await connect(urlA, resident);
    const s1 = await connect(urlA, m1);
    const s2 = await connect(urlB, m2);
    const out = await connect(urlB, outsider);
    const submitted = await submitAlert(appB, resident.id, 'medical');
    expect(submitted.statusCode).toBe(201);
    const incidentId = submitted.json<Body>().id as string;
    return { resident, circle, m1, m2, outsider, r, s1, s2, out, incidentId };
  }

  /**
   * Waits until the submit's own broadcasts are out (every event the submit recorded has been
   * broadcast by B, and the user-room counts / incoming arrived; on the events, not a fixed time,
   * gap 60), then joins the resident and both members, so no submit event reaches the room later.
   */
  async function joinAll(s: Scene) {
    const recorded = (
      await client.query<{ n: number }>(
        'select count(*)::int as n from public.incident_events where incident_id = $1',
        [s.incidentId],
      )
    ).rows[0].n;
    await eventually(() => {
      expect(eventBroadcastsDone.get(s.incidentId) ?? 0).toBeGreaterThanOrEqual(recorded);
      expect(s.r.of('incident.delivery_counts').length).toBeGreaterThan(0);
      for (const member of [s.s1, s.s2]) {
        expect(member.of('incident.incoming').length).toBeGreaterThan(0);
      }
    });
    for (const socket of [s.r, s.s1, s.s2]) {
      await expect(socket.join(s.incidentId)).resolves.toEqual({ ok: true });
    }
  }

  beforeAll(async () => {
    ({ app: appA, logs: logsA } = await createTestApp());
    ({ app: appB } = await createTestApp());
    await appA.listen(0, '127.0.0.1');
    await appB.listen(0, '127.0.0.1');
    urlA = await appA.getUrl();
    urlB = await appB.getUrl();
    client = await openTestClient();
    await eventually(async () => {
      await appA.get(RealtimeGateway).ping();
      await appB.get(RealtimeGateway).ping();
    });
    // Counts finished `incident.event` broadcasts of B (where every scene submits), so joinAll can
    // wait until the submit's own room events are out (gap 60: on the event, not a fixed time).
    // Not a jest spy: afterEach restores those.
    const broadcaster = appB.get(IncidentBroadcaster);
    const afterEvent = broadcaster.afterEvent.bind(broadcaster);
    broadcaster.afterEvent = async (event) => {
      try {
        await afterEvent(event);
      } finally {
        eventBroadcastsDone.set(
          event.incident_id,
          (eventBroadcastsDone.get(event.incident_id) ?? 0) + 1,
        );
      }
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client.end();
    await appA.close();
    await appB.close();
  });

  it('submit: the resident gets incident.delivery_counts on their user room, nobody else', async () => {
    const s = await scene();
    const counts = await s.r.next<Body>('incident.delivery_counts');
    const rest = (await getDeliveryCounts(appA, s.resident.id, s.incidentId)).json<Body>();
    expect(counts).toEqual({
      ...rest,
      updated_at: A_TIMESTAMP,
      occurred_at: A_TIMESTAMP,
    });
    expect(rest).toEqual({
      incident_id: s.incidentId,
      delivered_count: 2,
      acknowledged_count: 0,
      status: 'active',
    });
    await sleep(200);
    for (const socket of [s.s1, s.s2, s.out])
      expect(socket.of('incident.delivery_counts')).toEqual([]);
  });

  it('location, notes, re-notify, acknowledge, mark safe: each event with the REST values', async () => {
    const s = await scene();
    await s.r.next('incident.delivery_counts');
    await joinAll(s);

    // Location (on instance A; the member on B gets it too).
    const fix = {
      location_source: 'current',
      location_lat: 13.4549,
      location_lng: -16.579,
      location_accuracy_m: 12.5,
      location_captured_at: new Date().toISOString(),
    };
    expect((await attachLocation(appA, s.resident.id, s.incidentId, fix)).statusCode).toBe(200);
    const location = await s.s2.next<Body>('incident.location');
    const details = (await getIncidentDetails(appA, s.m2.id, s.incidentId)).json<Body>();
    expect(location).toEqual({
      incident_id: s.incidentId,
      location_source: 'current',
      location_lat: details.location_lat,
      location_lng: details.location_lng,
      location_accuracy_m: details.location_accuracy_m,
      location_captured_at: details.location_captured_at,
      location_unavailable_since: null,
      updated_at: A_TIMESTAMP,
      occurred_at: A_TIMESTAMP,
    });
    const updated = await s.s1.next<Body>('incident.updated');
    expect(Object.keys(updated).sort()).toEqual([
      'incident',
      'incident_id',
      'occurred_at',
      'updated_at',
    ]);
    const incident = updated.incident as Body;
    expect(Object.keys(incident).sort()).toEqual(UPDATED_KEYS);
    for (const key of UPDATED_KEYS) expect(incident[key]).toEqual(details[key]);
    expect(incident).not.toHaveProperty('resident_id');
    expect(incident).not.toHaveProperty('circle_id');
    await expect(s.r.next('incident.location')).resolves.toEqual(location);

    // Notes.
    expect(
      (
        await setIncidentNotes(appB, s.resident.id, s.incidentId, {
          incident_notes: ' Gate code 42 ',
        })
      ).statusCode,
    ).toBe(200);
    const notes = await s.s1.next<Body>('incident.notes');
    expect(notes).toMatchObject({ incident_id: s.incidentId, incident_notes: 'Gate code 42' });
    expect(notes.incident_notes_updated_at).toMatch(TIMESTAMP);
    expect((await s.s2.next<Body>('incident.notes')).incident_notes).toBe('Gate code 42');
    const afterNotes = await s.s1.next<Body>('incident.updated');
    expect((afterNotes.incident as Body).incident_notes).toBe('Gate code 42');

    // Re-notify.
    expect((await renotifyAlert(appA, s.resident.id, s.incidentId)).statusCode).toBe(200);
    const renotified = await s.s2.next<Body>('incident.renotified');
    const openIncident = (await getOpenIncident(appA, s.resident.id)).json<Body>()
      .open_incident as Body;
    expect(renotified).toEqual({
      incident_id: s.incidentId,
      renotified_at: openIncident.renotified_at,
      updated_at: A_TIMESTAMP,
      occurred_at: A_TIMESTAMP,
    });
    const renotifyEvent = await s.s1.next<Body>('incident.event');
    // The member view: actor masked, no recipient_ids (none on `renotified` anyway).
    expect((renotifyEvent.event as Body).event_type).toBe('renotified');
    expect((renotifyEvent.event as Body).actor_id).toMatch(MASKED);
    const residentRenotify = await s.r.next<Body>('incident.event');
    expect((residentRenotify.event as Body).actor_id).toBe(s.resident.id);

    // Acknowledge by m1: counts to the resident only.
    expect((await acknowledgeIncident(appB, s.m1.id, s.incidentId)).statusCode).toBe(200);
    await eventually(() =>
      expect(s.r.of<Body>('incident.delivery_counts').some((c) => c.acknowledged_count === 1)).toBe(
        true,
      ),
    );

    // Mark safe.
    expect((await markSafe(appA, s.resident.id, s.incidentId)).statusCode).toBe(200);
    const resolved = await s.s2.next<Body>('incident.resolved');
    const memberDetails = (await getIncidentDetails(appA, s.m2.id, s.incidentId)).json<Body>();
    expect(resolved).toEqual({
      incident_id: s.incidentId,
      status: 'resolved',
      resolved_at: memberDetails.resolved_at,
      resolved_reason: 'safe',
      location_sharing_ended_at: memberDetails.location_sharing_ended_at,
      updated_at: A_TIMESTAMP,
      occurred_at: A_TIMESTAMP,
    });
    await eventually(() =>
      expect(s.r.of<Body>('incident.delivery_counts').some((c) => c.status === 'resolved')).toBe(
        true,
      ),
    );

    // incident.event: each receiver got exactly what GET /events shows them (D3, D11).
    await eventually(async () => {
      for (const [socket, user] of [
        [s.r, s.resident],
        [s.s1, s.m1],
        [s.s2, s.m2],
      ] as const) {
        const rest = (await getIncidentEvents(appB, user.id, s.incidentId)).json<Body[]>();
        // The submit's own events (alert_sent, location_sharing_started) may be broadcast before or
        // after the sockets joined; only later writes are compared. Events of one write share
        // `occurred_at`, so REST orders them by id; compare by id.
        const submitEvents = ['alert_sent', 'location_sharing_started'];
        const byId = (a: Body, b: Body) => String(a.id).localeCompare(String(b.id));
        const live = socket
          .of<Body>('incident.event')
          .map((e) => e.event as Body)
          .filter((e) => !submitEvents.includes(e.event_type as string));
        expect([...live].sort(byId)).toEqual(
          rest.filter((e) => live.some((l) => l.id === e.id)).sort(byId),
        );
        // Live order = insertion order of each write.
        expect(live.map((e) => e.event_type)).toEqual([
          'renotified',
          // D71 (SCRUM-60/61): the member's first acknowledge.
          'responder_acknowledged',
          'safe_recorded',
          'location_sharing_ended',
          'closure_notified',
        ]);
      }
    });
    const closure = (socket: TestSocket) =>
      socket
        .of<Body>('incident.event')
        .find((e) => (e.event as Body).event_type === 'closure_notified')!.event as Body;
    expect((closure(s.r).detail as Body).recipient_ids).toEqual([s.m1.id, s.m2.id].sort());
    expect(closure(s.s1).detail).toEqual({ recipient_count: 2 });
    expect(closure(s.s1).actor_id).toMatch(MASKED);

    // Every event of every socket carries incident_id and occurred_at.
    for (const socket of [s.r, s.s1, s.s2]) {
      for (const [, payload] of socket.received) {
        expect((payload as Body).incident_id).toBe(s.incidentId);
        expect((payload as Body).occurred_at).toMatch(TIMESTAMP);
      }
    }
    // Members never got counts; the outsider got nothing at all.
    for (const socket of [s.s1, s.s2]) expect(socket.of('incident.delivery_counts')).toEqual([]);
    expect(s.out.received).toEqual([]);
  });

  it('SCRUM-68 (D74): unavailable keeps the last fix in incident.location / incident.updated; the next fix clears it', async () => {
    const s = await scene();
    await joinAll(s);
    const fix = {
      location_source: 'current',
      location_lat: 13.4549,
      location_lng: -16.579,
      location_accuracy_m: 12.5,
      location_captured_at: new Date(Date.now() - 60_000).toISOString(),
    };
    expect((await attachLocation(appA, s.resident.id, s.incidentId, fix)).statusCode).toBe(200);
    const live = await s.s2.next<Body>('incident.location');
    expect(live.location_unavailable_since).toBeNull();
    for (const socket of [s.r, s.s1]) await socket.next<Body>('incident.location');
    for (const socket of [s.r, s.s1, s.s2]) await socket.next<Body>('incident.updated');

    const unavailable = await attachLocation(appA, s.resident.id, s.incidentId, {
      location_source: 'unavailable',
    });
    expect(unavailable.statusCode).toBe(200);
    const since = unavailable.json<Body>().location_unavailable_since;
    expect(since).toMatch(TIMESTAMP);
    for (const socket of [s.r, s.s1, s.s2]) {
      // The resident and both members (on either instance) keep the last position, flagged.
      await expect(socket.next<Body>('incident.location')).resolves.toEqual({
        ...live,
        location_unavailable_since: since,
        updated_at: A_TIMESTAMP,
        occurred_at: A_TIMESTAMP,
      });
      const updated = await socket.next<Body>('incident.updated');
      expect(updated.incident).toMatchObject({
        location_source: 'current',
        location_lat: live.location_lat,
        location_lng: live.location_lng,
        location_accuracy_m: live.location_accuracy_m,
        location_captured_at: live.location_captured_at,
        location_unavailable_since: since,
      });
    }
    const details = (await getIncidentDetails(appA, s.m1.id, s.incidentId)).json<Body>();
    expect(details).toMatchObject({
      location_source: 'current',
      location_lat: live.location_lat,
      location_captured_at: live.location_captured_at,
      location_unavailable_since: since,
    });

    // A new fix: live again (the flag cleared) for everyone.
    const next = { ...fix, location_lat: 13.5, location_captured_at: new Date().toISOString() };
    expect((await attachLocation(appA, s.resident.id, s.incidentId, next)).statusCode).toBe(200);
    for (const socket of [s.r, s.s1, s.s2]) {
      await expect(socket.next<Body>('incident.location')).resolves.toMatchObject({
        location_source: 'current',
        location_lat: 13.5,
        location_unavailable_since: null,
      });
    }
  });

  it('a refused write (rolled back) broadcasts nothing', async () => {
    const s = await scene();
    await s.r.next('incident.delivery_counts');
    await joinAll(s);
    const tooLong = { incident_notes: 'x'.repeat(251) };
    expect((await setIncidentNotes(appA, s.resident.id, s.incidentId, tooLong)).statusCode).toBe(
      422,
    );
    // A member cannot write the resident's location.
    const fix = {
      location_source: 'current',
      location_lat: 1,
      location_lng: 1,
      location_accuracy_m: 10,
      location_captured_at: new Date().toISOString(),
    };
    expect((await attachLocation(appA, s.m1.id, s.incidentId, fix)).statusCode).toBe(404);
    await sleep(400);
    for (const socket of [s.r, s.s1, s.s2]) {
      // The submit's own user-room events (counts, incoming; API-100-42) came before the writes.
      const submitEvents = ['incident.delivery_counts', 'incident.incoming'];
      expect(socket.received.filter(([event]) => !submitEvents.includes(event))).toEqual([]);
    }
  });

  it('a failing broadcast never fails the request (logged, the write is saved)', async () => {
    const s = await scene();
    await s.r.next('incident.delivery_counts');
    await joinAll(s);
    jest
      .spyOn(appA.get(RealtimeReadsRepository), 'incidentState')
      .mockRejectedValue(new Error('read failed'));
    const reply = await setIncidentNotes(appA, s.resident.id, s.incidentId, {
      incident_notes: 'still saved',
    });
    expect(reply.statusCode).toBe(200);
    await eventually(() => expect(logsA.text).toContain('incident post-commit hook failed'));
    const details = (await getIncidentDetails(appB, s.m1.id, s.incidentId)).json<Body>();
    expect(details.incident_notes).toBe('still saved');
  });

  it('events of one incident never reach the room of another', async () => {
    const one = await scene();
    const two = await scene();
    await joinAll(one);
    await joinAll(two);
    const fix = {
      location_source: 'current',
      location_lat: 5,
      location_lng: 5,
      location_accuracy_m: 10,
      location_captured_at: new Date().toISOString(),
    };
    await attachLocation(appA, one.resident.id, one.incidentId, fix);
    await one.s1.next('incident.location');
    await sleep(300);
    for (const socket of [two.r, two.s1, two.s2])
      expect(socket.of('incident.location')).toEqual([]);
  });
});
