import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { maskActorId } from '../../src/modules/incidents/incident-actor-mask';
import { createTestApp } from '../../src/testing/test-app';
import { openTestClient } from '../support/database';
import { asSqlSharePayloadShape } from '../support/share-payload-shape';
import {
  addActiveMember,
  createCircle,
  createUser,
  inviteMember,
  type UserFixture,
} from '../support/fixtures';
import {
  acknowledgeIncident,
  attachLocation,
  getDeliveryCounts,
  getIncidentDetails,
  getIncidentEvents,
  getLiveLocationConfig,
  getOpenIncident,
  listRecentIncidents,
  listResponderIncidents,
  markSafe,
  renotifyAlert,
  setIncidentNotes,
  sqlOutcomeAs,
  submitAlert,
} from '../support/incident-api';

/**
 * API-100-23 AC3: the SQL functions and the API are interchangeable writers and readers of one
 * incident, in both directions, with a resident/member pair (plus a pending invitee and an
 * outsider). The same scenario runs four times on fresh users:
 *
 * - `sql→api`: the SQL function submits (today's app); every later call goes through the API
 *   (open read, recent list, config, location pings, notes, counts as resident and member, ack,
 *   responder list, details, events, re-submit, renotify, mark safe, and every call after the close);
 * - `api→sql`: the API submits; every later call goes through the SQL functions (and the events
 *   through RLS, the way the app could read them today);
 * - `sql` and `api`: everything through one side (the references).
 *
 * Every step's outcome (body or `fn:code`) and the final rows (`incidents`, `incident_deliveries`,
 * `incident_events`) must be the same in all four runs, once ids are replaced by role names and
 * server timestamps by their rank in the run. Two documented differences are applied to the SQL side
 * before comparing: the D2 wrapper of the open read, and D3/D11 on a member's view of the events
 * (RLS shows members every key and the full actor id; the API hides `recipient_ids` and masks
 * `actor_id`). `audit_log` and `idempotency_keys` are API-only and not compared.
 */
type Body = Record<string, unknown>;
type Outcome = { ok: true; body: unknown } | { ok: false; code: string };
type Mode = 'sql→api' | 'api→sql' | 'sql' | 'api';
type Side = 'sql' | 'api';

const FIX_AT = '2026-11-01T08:00:00Z';
const OLDER_FIX_AT = '2026-11-01T07:59:00Z';

interface Cast {
  resident: UserFixture;
  member: UserFixture;
  member2: UserFixture;
  pending: UserFixture;
  outsider: UserFixture;
  circleId: string;
  labels: Map<string, string>;
}

interface RunResult {
  steps: Record<string, Outcome>;
  rows: Body;
}

describe('Phase 1 gate: SQL and API writers are interchangeable (API-100-23 AC3)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  const results = {} as Record<Mode, RunResult>;
  const normalized = {} as Record<Mode, { steps: Record<string, unknown>; rows: unknown }>;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  async function castFor(): Promise<Cast> {
    // The same names in every run (names show in the bodies). The two members' ids are ordered
    // (member < member2), so the sorted `recipient_ids` normalize to the same list in every run.
    const resident = await createUser(client, { fullName: 'Gate Resident' });
    // Something to share, so the share_payload snapshot is not empty.
    await client.query(
      `update public.profiles set blood_type = 'O+', share_blood_type = true,
              allergies = 'Penicillin', share_allergies = true where id = $1`,
      [resident.id],
    );
    const [firstId, secondId] = [randomUUID(), randomUUID()].sort();
    const member = await createUser(client, { id: firstId, fullName: 'Gate Member' });
    const member2 = await createUser(client, { id: secondId, fullName: 'Gate Member Two' });
    const pending = await createUser(client, { fullName: 'Gate Pending' });
    const outsider = await createUser(client, { fullName: 'Gate Outsider' });
    const circle = await createCircle(client, resident);
    const m1 = await addActiveMember(client, circle, member);
    const m2 = await addActiveMember(client, circle, member2);
    const p = await inviteMember(client, circle, { claimedBy: pending });
    const labels = new Map<string, string>([
      [resident.id, 'resident'],
      [member.id, 'member'],
      [member2.id, 'member2'],
      [pending.id, 'pending'],
      [outsider.id, 'outsider'],
      [circle.id, 'circle'],
      [circle.ownerMemberId, 'row:owner'],
      [m1.id, 'row:member'],
      [m2.id, 'row:member2'],
      [p.id, 'row:pending'],
    ]);
    return {
      resident,
      member,
      member2,
      pending,
      outsider,
      circleId: circle.id,
      labels,
    };
  }

  const fromApi = (reply: Awaited<ReturnType<typeof submitAlert>>): Outcome =>
    reply.statusCode < 300
      ? { ok: true, body: reply.json<unknown>() }
      : { ok: false, code: reply.json<{ error: { code: string } }>().error.code };

  const fromSql = async (
    userId: string,
    call: string,
    params: unknown[] = [],
  ): Promise<Outcome> => {
    const outcome = await sqlOutcomeAs(client, userId, call, params);
    return outcome.ok ? { ok: true, body: outcome.body } : { ok: false, code: outcome.code };
  };

  /** Events as `userId` sees them through RLS (the `authenticated` role), API keys and order. */
  async function eventsViaRls(userId: string, incidentId: string): Promise<Outcome> {
    await client.query('begin');
    try {
      await client.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true),
                set_config('TimeZone', 'UTC', true)`,
        [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
      );
      await client.query('set local role authenticated');
      const { rows } = await client.query<{ body: Body[] }>(
        `select coalesce(jsonb_agg(jsonb_build_object('id', id, 'event_type', event_type,
                  'occurred_at', occurred_at, 'actor_id', actor_id, 'detail', detail)
                  order by occurred_at, id), '[]'::jsonb) as body
           from public.incident_events where incident_id = $1`,
        [incidentId],
      );
      await client.query('commit');
      return { ok: true, body: rows[0].body };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }

  /** D3 + D11 applied to an RLS read, as the API serves a non-resident. */
  function memberView(outcome: Outcome, callerId: string): Outcome {
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      body: (outcome.body as Body[]).map((event) => {
        const detail = { ...(event.detail as Body) };
        delete detail.recipient_ids;
        return { ...event, actor_id: maskActorId(event.actor_id, callerId), detail };
      }),
    };
  }

  /** The final rows of the incident, timestamps in UTC as JSON text. */
  async function rowsOf(incidentId: string): Promise<Body> {
    await client.query('begin');
    try {
      await client.query(`set local TimeZone = 'UTC'`);
      const incident = await client.query<{ row: Body }>(
        'select to_jsonb(i) as row from public.incidents i where id = $1',
        [incidentId],
      );
      const deliveries = await client.query<{ row: Body }>(
        `select to_jsonb(d) - 'id' as row from public.incident_deliveries d
          where incident_id = $1`,
        [incidentId],
      );
      const events = await client.query<{ row: Body }>(
        `select to_jsonb(e) - 'id' as row from public.incident_events e where incident_id = $1`,
        [incidentId],
      );
      return {
        incident: incident.rows[0].row,
        deliveries: deliveries.rows.map((r) => r.row),
        events: events.rows.map((r) => r.row),
      };
    } finally {
      await client.query('commit');
    }
  }

  /** Runs the scenario: `submitSide` submits, `restSide` does everything after it. */
  async function run(mode: Mode): Promise<{ cast: Cast; result: RunResult; incidentId: string }> {
    const submitSide: Side = mode === 'sql' || mode === 'sql→api' ? 'sql' : 'api';
    const restSide: Side = mode === 'sql' || mode === 'api→sql' ? 'sql' : 'api';
    const cast = await castFor();
    const { resident, member, member2, pending, outsider } = cast;
    const steps: Record<string, Outcome> = {};

    steps.submit =
      submitSide === 'sql'
        ? await fromSql(resident.id, 'public.submit_emergency_alert($1)', ['medical'])
        : fromApi(await submitAlert(app, resident.id, 'medical'));
    expect(steps.submit.ok).toBe(true);
    const incidentId = (steps.submit as { body: { id: string } }).body.id;
    cast.labels.set(incidentId, 'incident');

    const api = restSide === 'api';
    const id = incidentId;
    const ping = (body: Body) => attachLocation(app, resident.id, id, body);
    const sqlPing = (source: string, lat: unknown, lng: unknown, acc: unknown, at: unknown) =>
      fromSql(resident.id, 'public.attach_incident_location($1, $2, $3, $4, $5, $6)', [
        id,
        source,
        lat,
        lng,
        acc,
        at,
      ]);

    const call = async (
      name: string,
      viaApi: () => Promise<Outcome>,
      viaSql: () => Promise<Outcome>,
    ) => {
      steps[name] = api ? await viaApi() : await viaSql();
    };

    await call(
      'open (resident)',
      async () => {
        const out = fromApi(await getOpenIncident(app, resident.id));
        // D2: the API wraps the open incident; compare the incident itself.
        return out.ok ? { ok: true, body: (out.body as Body).open_incident } : out;
      },
      () => fromSql(resident.id, 'public.get_my_open_incident()'),
    );
    await call(
      'config',
      async () => fromApi(await getLiveLocationConfig(app, resident.id)),
      () => fromSql(resident.id, 'public.get_live_location_config()'),
    );
    await call(
      'ping current',
      async () =>
        fromApi(
          await ping({
            location_source: 'current',
            location_lat: 13.4549,
            location_lng: -16.579,
            location_accuracy_m: 8.5,
            location_captured_at: FIX_AT,
          }),
        ),
      () => sqlPing('current', 13.4549, -16.579, 8.5, FIX_AT),
    );
    await call(
      'ping older (ignored)',
      async () =>
        fromApi(
          await ping({
            location_source: 'last_known',
            location_lat: 1,
            location_lng: 1,
            location_captured_at: OLDER_FIX_AT,
          }),
        ),
      () => sqlPing('last_known', 1, 1, null, OLDER_FIX_AT),
    );
    await call(
      'notes',
      async () =>
        fromApi(await setIncidentNotes(app, resident.id, id, { incident_notes: '  Gate note  ' })),
      () => fromSql(resident.id, 'public.set_incident_notes($1, $2)', [id, '  Gate note  ']),
    );
    await call(
      'counts (resident)',
      async () => fromApi(await getDeliveryCounts(app, resident.id, id)),
      () => fromSql(resident.id, 'public.incident_delivery_counts($1)', [id]),
    );
    await call(
      'counts (member)',
      async () => fromApi(await getDeliveryCounts(app, member.id, id)),
      () => fromSql(member.id, 'public.incident_delivery_counts($1)', [id]),
    );
    await call(
      'ack (member)',
      async () => fromApi(await acknowledgeIncident(app, member.id, id)),
      () => fromSql(member.id, 'public.acknowledge_incident($1)', [id]),
    );
    await call(
      'ack again (member)',
      async () => fromApi(await acknowledgeIncident(app, member.id, id)),
      () => fromSql(member.id, 'public.acknowledge_incident($1)', [id]),
    );
    await call(
      'responder list (member)',
      async () => fromApi(await listResponderIncidents(app, member.id)),
      () => fromSql(member.id, 'public.list_responder_incidents()'),
    );
    await call(
      'details (member)',
      async () => fromApi(await getIncidentDetails(app, member.id, id)),
      () => fromSql(member.id, 'public.get_incident_details($1)', [id]),
    );
    for (const [who, user] of [
      ['pending', pending],
      ['outsider', outsider],
    ] as const) {
      await call(
        `details (${who})`,
        async () => fromApi(await getIncidentDetails(app, user.id, id)),
        () => fromSql(user.id, 'public.get_incident_details($1)', [id]),
      );
      await call(
        `counts (${who})`,
        async () => fromApi(await getDeliveryCounts(app, user.id, id)),
        () => fromSql(user.id, 'public.incident_delivery_counts($1)', [id]),
      );
    }
    await call(
      're-submit (renotified)',
      async () => fromApi(await submitAlert(app, resident.id, 'fire')),
      () => fromSql(resident.id, 'public.submit_emergency_alert($1)', ['fire']),
    );
    await call(
      'renotify',
      async () => fromApi(await renotifyAlert(app, resident.id, id)),
      () => fromSql(resident.id, 'public.renotify_emergency_alert($1)', [id]),
    );
    await call(
      'ping unavailable',
      async () => fromApi(await ping({ location_source: 'unavailable' })),
      () => sqlPing('unavailable', null, null, null, null),
    );
    await call(
      'mark safe',
      async () => fromApi(await markSafe(app, resident.id, id)),
      () => fromSql(resident.id, 'public.mark_incident_safe($1)', [id]),
    );

    // After the close.
    await call(
      'mark safe retry',
      async () => fromApi(await markSafe(app, resident.id, id)),
      () => fromSql(resident.id, 'public.mark_incident_safe($1)', [id]),
    );
    await call(
      'open after close',
      async () => {
        const out = fromApi(await getOpenIncident(app, resident.id));
        return out.ok ? { ok: true, body: (out.body as Body).open_incident } : out;
      },
      () => fromSql(resident.id, 'public.get_my_open_incident()'),
    );
    await call(
      'recent (resident)',
      async () => fromApi(await listRecentIncidents(app, resident.id)),
      () => fromSql(resident.id, 'public.list_my_recent_incidents()'),
    );
    await call(
      'ping after close',
      async () => fromApi(await ping({ location_source: 'unavailable' })),
      () => sqlPing('unavailable', null, null, null, null),
    );
    await call(
      'notes after close',
      async () => fromApi(await setIncidentNotes(app, resident.id, id, { incident_notes: 'late' })),
      () => fromSql(resident.id, 'public.set_incident_notes($1, $2)', [id, 'late']),
    );
    await call(
      'renotify after close',
      async () => fromApi(await renotifyAlert(app, resident.id, id)),
      () => fromSql(resident.id, 'public.renotify_emergency_alert($1)', [id]),
    );
    await call(
      'ack after close (member2)',
      async () => fromApi(await acknowledgeIncident(app, member2.id, id)),
      () => fromSql(member2.id, 'public.acknowledge_incident($1)', [id]),
    );
    await call(
      'counts after close (resident)',
      async () => fromApi(await getDeliveryCounts(app, resident.id, id)),
      () => fromSql(resident.id, 'public.incident_delivery_counts($1)', [id]),
    );
    await call(
      'counts after close (member)',
      async () => fromApi(await getDeliveryCounts(app, member.id, id)),
      () => fromSql(member.id, 'public.incident_delivery_counts($1)', [id]),
    );
    await call(
      'details after close (member)',
      async () => fromApi(await getIncidentDetails(app, member.id, id)),
      () => fromSql(member.id, 'public.get_incident_details($1)', [id]),
    );
    await call(
      'events (resident)',
      async () => fromApi(await getIncidentEvents(app, resident.id, id)),
      () => eventsViaRls(resident.id, id),
    );
    await call(
      'events (member)',
      async () => fromApi(await getIncidentEvents(app, member.id, id)),
      async () => memberView(await eventsViaRls(member.id, id), member.id),
    );
    await call(
      'events (outsider)',
      async () => {
        const out = fromApi(await getIncidentEvents(app, outsider.id, id));
        // RLS answers an empty list where the API answers not_found (hidden existence).
        return !out.ok && out.code === 'incident_events:not_found' ? { ok: true, body: [] } : out;
      },
      () => eventsViaRls(outsider.id, id),
    );

    return { cast, incidentId, result: { steps, rows: await rowsOf(incidentId) } };
  }

  // --- normalization -------------------------------------------------------------------------

  const TIMESTAMP =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:\+00(?::00)?|Z)$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const timestampKey = (value: string) => {
    const m = TIMESTAMP.exec(value);
    return m ? `${m[1]}T${m[2]}.${(m[3] ?? '').padEnd(6, '0')}` : null;
  };

  function collectTimestamps(value: unknown, into: Set<string>): void {
    if (typeof value === 'string') {
      const key = timestampKey(value);
      if (key) into.add(key);
    } else if (Array.isArray(value)) {
      value.forEach((item) => collectTimestamps(item, into));
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach((item) => collectTimestamps(item, into));
    }
  }

  /** Ids → role names (masked ids → `mask(role)`), timestamps → `T<rank in the run>`. */
  function normalizer(cast: Cast, all: unknown) {
    const keys = new Set<string>();
    collectTimestamps(all, keys);
    const rank = new Map([...keys].sort().map((key, index) => [key, `T${index}`]));
    const masked = new Map<string, string>();
    for (const [id, label] of cast.labels) {
      const m = maskActorId(id, '00000000-0000-0000-0000-000000000000');
      if (m) masked.set(m, `mask(${label})`);
    }
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const key = timestampKey(value);
        if (key) return rank.get(key);
        if (cast.labels.has(value)) return cast.labels.get(value);
        if (masked.has(value)) return masked.get(value);
        if (UUID.test(value)) return 'uuid';
        return value;
      }
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      }
      return value;
    };
    return walk;
  }

  /** Sort key of a normalized event: time rank (`T<n>`), then type. */
  const eventKey = (event: Body) =>
    `${String(Number(String(event.occurred_at).slice(1))).padStart(4, '0')}|${String(event.event_type)}`;
  const byEventKey = (a: Body, b: Body) => eventKey(a).localeCompare(eventKey(b));

  /** Deliveries by member; events by time rank then type (one transaction shares occurred_at). */
  function canonicalRows(rows: unknown): unknown {
    const r = rows as { incident: Body; deliveries: Body[]; events: Body[] };
    return {
      incident: r.incident,
      deliveries: [...r.deliveries].sort((a, b) =>
        String(a.member_user_id).localeCompare(String(b.member_user_id)),
      ),
      events: [...r.events].sort(byEventKey),
    };
  }

  function canonicalSteps(steps: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, outcome] of Object.entries(steps)) {
      const o = outcome as { ok: boolean; body?: unknown };
      if (name.startsWith('events') && o.ok && Array.isArray(o.body)) {
        // Same-transaction events share occurred_at; their id order is random (uuid).
        out[name] = {
          ...o,
          body: (o.body as Body[]).map((event) => ({ ...event, id: 'uuid' })).sort(byEventKey),
        };
      } else {
        out[name] = outcome;
      }
    }
    return out;
  }

  /**
   * SCRUM-63 recorded divergences, taken out before the runs are compared: the SQL mark safe writes
   * `incident_closed` while the API writes it only at the real close (D62), and the API's recent list
   * also carries `auto_closed` (D63; `closed_at` is taken out by `asSqlSharePayloadShape`).
   */
  function withoutScrum63Divergence(
    steps: Record<string, unknown>,
    rows: unknown,
  ): { steps: Record<string, unknown>; rows: unknown } {
    const notClosedEvent = (event: Body) => event.event_type !== 'incident_closed';
    const outSteps: Record<string, unknown> = {};
    for (const [name, outcome] of Object.entries(steps)) {
      const o = outcome as { ok: boolean; body?: unknown };
      if (name.startsWith('events') && o.ok && Array.isArray(o.body)) {
        outSteps[name] = { ...o, body: (o.body as Body[]).filter(notClosedEvent) };
      } else if (name.startsWith('recent') && o.ok && Array.isArray(o.body)) {
        outSteps[name] = {
          ...o,
          body: (o.body as Body[]).map((item) => {
            const rest = { ...item };
            delete rest.auto_closed;
            return rest;
          }),
        };
      } else {
        outSteps[name] = outcome;
      }
    }
    const r = rows as { incident: Body; deliveries: Body[]; events: Body[] };
    return { steps: outSteps, rows: { ...r, events: r.events.filter(notClosedEvent) } };
  }

  /**
   * D71 (SCRUM-60/61) recorded divergence, taken out before the runs are compared (after the
   * SCRUM-63 one): the API's acknowledge writes a `responder_acknowledged` event (the SQL function
   * writes none), and every event the API reads carries `actor_name`. Both are checked by
   * `test/int/incidents-activity-scrum60-61.int-spec.ts`.
   */
  function withoutD71Divergence(compared: { steps: Record<string, unknown>; rows: unknown }): {
    steps: Record<string, unknown>;
    rows: unknown;
  } {
    const notResponderEvent = (event: Body) =>
      event.event_type !== 'responder_acknowledged' && event.event_type !== 'responder_status';
    const steps: Record<string, unknown> = {};
    for (const [name, outcome] of Object.entries(compared.steps)) {
      const o = outcome as { ok: boolean; body?: unknown };
      if (name.startsWith('events') && o.ok && Array.isArray(o.body)) {
        steps[name] = {
          ...o,
          body: (o.body as Body[]).filter(notResponderEvent).map((event) => {
            const rest = { ...event };
            delete rest.actor_name;
            return rest;
          }),
        };
      } else {
        steps[name] = outcome;
      }
    }
    const r = compared.rows as { incident: Body; deliveries: Body[]; events: Body[] };
    return { steps, rows: { ...r, events: r.events.filter(notResponderEvent) } };
  }

  /**
   * Gap 59 recorded divergence (approved by Dawit 2026-11-25), taken out of a RAW run before it is
   * normalized: the API stores `location_sharing_started` at `clock_timestamp()`, just after the
   * submit's `alert_sent` (the SQL function stores both at the transaction time), so the API run has
   * one more distinct instant. Each event list gets the location start back at its `alert_sent`
   * time. The strict order itself is checked by `test/int/activity-scrum82.int-spec.ts`.
   */
  function withoutGap59Divergence(result: RunResult): RunResult {
    const align = (events: Body[]): Body[] => {
      const sent = events.find((event) => event.event_type === 'alert_sent');
      return events.map((event) =>
        sent && event.event_type === 'location_sharing_started'
          ? { ...event, occurred_at: sent.occurred_at }
          : event,
      );
    };
    const steps: Record<string, Outcome> = {};
    for (const [name, outcome] of Object.entries(result.steps)) {
      const o = outcome as { ok: boolean; body?: unknown };
      steps[name] =
        name.startsWith('events') && o.ok && Array.isArray(o.body)
          ? ({ ...o, body: align(o.body as Body[]) } as Outcome)
          : outcome;
    }
    const rows = result.rows as Body & { events?: Body[] };
    return {
      steps,
      rows: Array.isArray(rows.events) ? { ...rows, events: align(rows.events) } : rows,
    };
  }

  /**
   * SCRUM-68 (D74) recorded divergence, taken out of a RAW run first: an `unavailable` ping keeps the
   * stored fix and sets `location_unavailable_since` (the SQL function wipes the fix), and every
   * incident body and row carries `location_unavailable_since`. Each object with the location keys
   * is shown as the SQL shows it: when the key is set, the fix becomes `unavailable` with null
   * position columns; the key is then removed. The D74 behaviour itself is checked by
   * `test/int/locations-last-known-scrum68.int-spec.ts`.
   */
  function withoutD74Divergence<T>(value: T): T {
    if (Array.isArray(value))
      return value.map((item) => withoutD74Divergence(item) as unknown) as T;
    if (!value || typeof value !== 'object') return value;
    const out: Body = {};
    for (const [key, entry] of Object.entries(value as Body)) {
      out[key] = withoutD74Divergence(entry);
    }
    if ('location_unavailable_since' in out) {
      if (out.location_unavailable_since !== null) {
        out.location_source = 'unavailable';
        for (const key of [
          'location_lat',
          'location_lng',
          'location_accuracy_m',
          'location_captured_at',
        ]) {
          if (key in out) out[key] = null;
        }
      }
      delete out.location_unavailable_since;
    }
    return out as T;
  }

  /** Both recorded divergences (SCRUM-63, D71) taken out of a normalized run. */
  const comparable = (mode: Mode) =>
    withoutD71Divergence(withoutScrum63Divergence(normalized[mode].steps, normalized[mode].rows));

  const MODES: Mode[] = ['sql', 'api', 'sql→api', 'api→sql'];

  it.each(MODES)('%s: the scenario runs through', async (mode) => {
    const { cast, result: raw } = await run(mode);
    results[mode] = raw;
    const result = withoutGap59Divergence(withoutD74Divergence(raw));
    const walk = normalizer(cast, result);
    // SCRUM-21 (D52, D53): the API's list values are arrays and member details carry two more keys;
    // compared in the SQL shape (`asSqlSharePayloadShape`), everything else exactly.
    normalized[mode] = {
      steps: canonicalSteps(asSqlSharePayloadShape(walk(result.steps)) as Record<string, unknown>),
      rows: canonicalRows(asSqlSharePayloadShape(walk(result.rows))),
    };
  });

  it('the reference run shows what the scenario covers', () => {
    const steps = normalized.sql.steps as Record<
      string,
      { ok: boolean; code?: string; body?: unknown }
    >;
    expect(steps.submit).toMatchObject({ ok: true, body: { submit_outcome: 'created' } });
    expect(steps['re-submit (renotified)']).toMatchObject({
      ok: true,
      body: { submit_outcome: 'renotified', emergency_type: 'medical' },
    });
    expect(steps['ping older (ignored)'].body).toMatchObject({ location_lat: 13.4549 });
    expect(steps['ack (member)'].body).toMatchObject({ acknowledged_count: 1, delivered_count: 2 });
    expect(steps['details (pending)']).toEqual({
      ok: false,
      code: 'get_incident_details:not_found',
    });
    expect(steps['counts (outsider)']).toEqual({
      ok: false,
      code: 'incident_delivery_counts:not_found',
    });
    expect(steps['mark safe'].body).toMatchObject({ status: 'resolved', resolved_reason: 'safe' });
    expect(steps['mark safe retry']).toEqual(steps['mark safe']);
    expect(steps['open after close']).toEqual({ ok: true, body: null });
    expect(steps['ping after close']).toEqual({
      ok: false,
      code: 'attach_incident_location:not_open',
    });
    expect(steps['notes after close']).toEqual({ ok: false, code: 'set_incident_notes:not_open' });
    expect(steps['renotify after close']).toEqual({
      ok: false,
      code: 'renotify_emergency_alert:not_open',
    });
    expect(steps['ack after close (member2)']).toEqual({
      ok: false,
      code: 'acknowledge_incident:not_open',
    });
    expect(steps['counts after close (member)']).toEqual({
      ok: false,
      code: 'incident_delivery_counts:not_found',
    });
    expect(steps['details after close (member)']).toMatchObject({
      ok: true,
      body: { status: 'resolved' },
    });
    const residentEvents = (steps['events (resident)'].body as Body[]).map((e) => e.event_type);
    expect(residentEvents.sort()).toEqual(
      [
        'alert_sent',
        'closure_notified',
        'incident_closed',
        'location_sharing_ended',
        'location_sharing_started',
        'renotified',
        'renotified',
        'safe_recorded',
      ].sort(),
    );
    const memberAlert = (steps['events (member)'].body as Body[]).find(
      (e) => e.event_type === 'alert_sent',
    );
    expect(memberAlert).toMatchObject({ actor_id: 'mask(resident)' });
    expect(memberAlert?.detail).not.toHaveProperty('recipient_ids');
  });

  it('D71: the API acknowledge recorded responder_acknowledged; API events carry actor_name', () => {
    const steps = normalized.api.steps as Record<string, { ok: boolean; body?: unknown }>;
    const events = steps['events (member)'].body as Body[];
    expect(events.filter((e) => e.event_type === 'responder_acknowledged')).toEqual([
      expect.objectContaining({ actor_id: 'member', detail: {} }),
    ]);
    for (const event of events) expect(typeof event.actor_name).toBe('string');
    const rows = normalized.api.rows as { events: Body[] };
    expect(rows.events.filter((e) => e.event_type === 'responder_acknowledged')).toHaveLength(1);
  });

  it.each(['api', 'sql→api', 'api→sql'] as const)(
    '%s: every step answers as in the SQL-only run',
    (mode) => {
      expect(comparable(mode).steps).toEqual(comparable('sql').steps);
    },
  );

  it.each(['api', 'sql→api', 'api→sql'] as const)(
    '%s: the same final incident, delivery and event rows as the SQL-only run',
    (mode) => {
      expect(comparable(mode).rows).toEqual(comparable('sql').rows);
    },
  );

  it('the final rows are what the SQL functions leave behind', () => {
    const rows = normalized.sql.rows as { incident: Body; deliveries: Body[]; events: Body[] };
    expect(rows.incident).toMatchObject({
      resident_id: 'resident',
      circle_id: 'circle',
      status: 'resolved',
      resolved_reason: 'safe',
      emergency_type: 'medical',
      incident_notes: 'Gate note',
      location_source: 'unavailable',
      share_payload: { blood_type: 'O+', allergies: 'Penicillin' },
    });
    expect(rows.incident.resolved_at).toBe(rows.incident.location_sharing_ended_at);
    expect(rows.deliveries.map((d) => [d.member_user_id, d.acknowledged_at !== null])).toEqual([
      ['member', true],
      ['member2', false],
    ]);
    expect(rows.events).toHaveLength(8);
  });

  /**
   * Side by side with today's app: an API renotify next to an SQL submit (the profile lock order).
   * Mark safe has the same check in incidents-mark-safe.int-spec.ts.
   */
  describe('renotify and submit on separate connections (lock order)', () => {
    async function waitForLockWaiters(count: number): Promise<void> {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { rows } = await client.query<{ n: number }>(
          `select count(distinct pid)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (rows[0].n >= count) return;
        if (Date.now() > deadline) throw new Error(`only ${rows[0].n} of ${count} waiting`);
        await new Promise((done) => setTimeout(done, 10));
      }
    }

    /** Submit's first two steps on another connection: the profile, then the open incident. */
    async function submitStepsAround(residentId: string, during: () => Promise<void>) {
      const holder = await openTestClient();
      try {
        await holder.query('begin');
        await holder.query('select 1 from public.profiles where id = $1 for update', [residentId]);
        await during();
        await holder.query(`set local lock_timeout = '5s'`);
        const second = holder
          .query(
            `select status from public.incidents
              where resident_id = $1 and status in ('activating', 'active') for update`,
            [residentId],
          )
          .then(
            (result) => ({ ok: true as const, rows: result.rows as Body[] }),
            (error: { code?: string }) => ({ ok: false as const, code: error.code }),
          );
        return { holder, second };
      } catch (error) {
        await holder.end();
        throw error;
      }
    }

    it('the API waits on the profile first, so the submit goes on (no deadlock)', async () => {
      const resident = await createUser(client);
      const circle = await createCircle(client, resident);
      await addActiveMember(client, circle, await createUser(client));
      const id = (await submitAlert(app, resident.id, 'medical')).json<{ id: string }>().id;

      let renotifying!: ReturnType<typeof renotifyAlert>;
      const { holder, second } = await submitStepsAround(resident.id, async () => {
        renotifying = renotifyAlert(app, resident.id, id);
        await waitForLockWaiters(1);
      });
      expect(await second).toEqual({ ok: true, rows: [{ status: 'active' }] });
      await holder.query('commit');
      await holder.end();
      expect((await renotifying).statusCode).toBe(200);
    });

    it('for contrast: the SQL function in the same interleaving deadlocks (40P01)', async () => {
      const resident = await createUser(client);
      const circle = await createCircle(client, resident);
      await addActiveMember(client, circle, await createUser(client));
      const id = (await submitAlert(app, resident.id, 'medical')).json<{ id: string }>().id;

      const renotifier = await openTestClient();
      try {
        let renotifying!: Promise<string | null>;
        const { holder, second } = await submitStepsAround(resident.id, async () => {
          renotifying = sqlOutcomeAs(
            renotifier,
            resident.id,
            'public.renotify_emergency_alert($1)',
            [id],
          ).then((outcome) => (outcome.ok ? null : outcome.sqlState));
          await waitForLockWaiters(1);
        });
        const [sqlState, locked] = await Promise.all([renotifying, second]);
        await holder.query('rollback');
        await holder.end();
        expect([sqlState, locked.ok ? null : locked.code]).toContain('40P01');
      } finally {
        await renotifier.end();
      }
    });
  });
});
