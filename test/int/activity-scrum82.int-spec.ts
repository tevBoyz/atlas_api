import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { Client } from 'pg';

import { JobWorkers } from '../../src/jobs/job-workers';
import { encodeActivityCursor } from '../../src/modules/activity/activity.schemas';
import { IncidentCloseSweeper } from '../../src/modules/incidents/incident-close-sweeper';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { createTestWorker } from '../../src/testing/test-worker';
import { leaveCircle, removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type MemberFixture,
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

/**
 * SCRUM-82 (View Emergency Activity Log), decision D72: `GET /v1/me/activity?category=&before=&limit=`.
 * My Emergencies = the caller's own alerts (sent, location shared, every member's acknowledged /
 * responding / unable, one ended); Circle Alerts = others' alerts inside the access window (received,
 * the caller's OWN responses, the resident's status updates, one ended); newest first by
 * (occurred_at, id) with a cursor carrying both; no user id anywhere; 401 / 422.
 */
type Body = Record<string, unknown>;
type Entry = {
  id: string;
  kind: string;
  category: string;
  occurred_at: string;
  incident: Body;
  actor_name: string | null;
  detail: Body | null;
};
type Page = { entries: Entry[]; next_cursor: string | null };

const CONFIG = {
  RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
  RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
  DATABASE_POOL_MAX: '20',
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('SCRUM-82 activity log (D72)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let worker: TestingModule;
  let sweeper: IncidentCloseSweeper;

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    client = await openTestClient();
    ({ worker } = await createTestWorker((builder) =>
      builder.overrideProvider(JobWorkers).useValue({}),
    ));
    sweeper = worker.get(IncidentCloseSweeper);
  });

  afterAll(async () => {
    await client?.end();
    await worker?.close();
    await app?.close();
  });

  async function activity(userId: string | null, query = '') {
    return app.inject({
      method: 'GET',
      url: `/v1/me/activity${query}`,
      headers: userId === null ? {} : await authHeader(userId),
    });
  }

  async function page(userId: string, query = ''): Promise<Page> {
    const reply = await activity(userId, query);
    expect(reply.statusCode).toBe(200);
    return reply.json<Page>();
  }

  /** Every entry of a category, all pages of `limit`. */
  async function all(userId: string, category = 'all', limit = 50): Promise<Entry[]> {
    const out: Entry[] = [];
    let before: string | null = null;
    for (let i = 0; i < 100; i++) {
      const q = `?category=${category}&limit=${limit}${before ? `&before=${before}` : ''}`;
      const p = await page(userId, q);
      out.push(...p.entries);
      before = p.next_cursor;
      if (!before) return out;
    }
    throw new Error('too many pages');
  }

  async function respond(userId: string, incidentId: string, status: string) {
    const reply = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${incidentId}/response`,
      headers: { ...(await authHeader(userId)), 'content-type': 'application/json' },
      payload: JSON.stringify({ status }),
    });
    expect(reply.statusCode).toBe(200);
  }

  /** Oldest first as `kind[:actor]` (strict order: gap 59 makes "Sent" precede "Location Shared"). */
  const kinds = (entries: Entry[], incidentId?: string) =>
    entries
      .filter((e) => incidentId === undefined || e.incident.id === incidentId)
      .reverse()
      .map((e) => (e.actor_name && e.kind !== 'ended' ? `${e.kind}:${e.actor_name}` : e.kind));

  interface Scene {
    rita: UserFixture;
    milo: UserFixture;
    ned: UserFixture;
    zed: UserFixture;
    zedRow: MemberFixture;
    outsider: UserFixture;
    circle: CircleFixture;
    incidentId: string;
  }

  /**
   * Rita's medical alert: Milo acknowledges then responds, Ned is unable, Rita sends a preset and a
   * text update, re-notifies, then marks safe. Zed is a member who does nothing.
   */
  async function scene(): Promise<Scene> {
    const tag = randomUUID().slice(0, 4);
    const rita = await createUser(client, { fullName: ` Rita ${tag} ` });
    const circle = await createCircle(client, rita);
    const milo = await createUser(client, { fullName: `Milo ${tag}` });
    const ned = await createUser(client, { fullName: `Ned ${tag}` });
    const zed = await createUser(client, { fullName: `Zed ${tag}` });
    const outsider = await createUser(client);
    await addActiveMember(client, circle, milo);
    await addActiveMember(client, circle, ned);
    const zedRow = await addActiveMember(client, circle, zed);
    const submitted = await submitAlert(app, rita.id, 'medical');
    expect(submitted.statusCode).toBe(201);
    const incidentId = submitted.json<Body>().id as string;
    expect((await acknowledgeIncident(app, milo.id, incidentId)).statusCode).toBe(200);
    await respond(milo.id, incidentId, 'responding');
    await respond(ned.id, incidentId, 'unable');
    expect(
      (await sendIncidentUpdate(app, rita.id, incidentId, { preset: 'help_is_here' })).statusCode,
    ).toBe(201);
    expect(
      (await sendIncidentUpdate(app, rita.id, incidentId, { text: 'At the gate' })).statusCode,
    ).toBe(201);
    expect((await renotifyAlert(app, rita.id, incidentId)).statusCode).toBe(200);
    expect((await markSafe(app, rita.id, incidentId)).statusCode).toBe(200);
    return { rita, milo, ned, zed, zedRow, outsider, circle, incidentId };
  }

  it('My Emergencies: sent, location shared, every response by name, one ended (no updates, re-notify, location end, closure)', async () => {
    const s = await scene();
    const mine = await all(s.rita.id, 'mine');
    expect(kinds(mine)).toEqual([
      `emergency_initiated:${s.rita.fullName.trim()}`,
      `location_shared:${s.rita.fullName.trim()}`,
      `acknowledged:${s.milo.fullName}`,
      `responding:${s.milo.fullName}`,
      `acknowledged:${s.ned.fullName}`,
      `unable:${s.ned.fullName}`,
      'ended',
    ]);
    for (const entry of mine) {
      expect(entry.category).toBe('mine');
      expect(entry.incident).toEqual({
        id: s.incidentId,
        status: 'resolved',
        emergency_type: 'medical',
        resident_name: null,
        circle_name: null,
      });
    }
    const ended = mine.find((e) => e.kind === 'ended')!;
    expect(ended.detail).toEqual({ reason: 'safe' });
    expect(ended.actor_name).toBe(s.rita.fullName.trim());
    expect(mine.filter((e) => e.kind !== 'ended').every((e) => e.detail === null)).toBe(true);
    // "all" for the resident = mine (no circle alerts); "circle" is empty.
    expect(await all(s.rita.id, 'all')).toEqual(mine);
    expect((await page(s.rita.id, '?category=circle')).entries).toEqual([]);
  });

  it('Circle Alerts: received, only my own responses, the status updates, one ended', async () => {
    const s = await scene();
    const milo = await all(s.milo.id, 'circle');
    const rita = s.rita.fullName.trim();
    expect(kinds(milo)).toEqual([
      `alert_received:${rita}`,
      `acknowledged:${s.milo.fullName}`,
      `responding:${s.milo.fullName}`,
      `status_update:${rita}`,
      `status_update:${rita}`,
      'ended',
    ]);
    const updates = milo.filter((e) => e.kind === 'status_update').reverse();
    expect(updates.map((e) => e.detail)).toEqual([
      { preset: 'help_is_here', text: null },
      { preset: null, text: 'At the gate' },
    ]);
    for (const entry of milo) {
      expect(entry.category).toBe('circle');
      expect(entry.incident).toEqual({
        id: s.incidentId,
        status: 'resolved',
        emergency_type: 'medical',
        resident_name: rita,
        circle_name: 'My Safety Circle',
      });
    }
    const ned = await all(s.ned.id, 'circle');
    expect(kinds(ned)).toEqual([
      `alert_received:${rita}`,
      `acknowledged:${s.ned.fullName}`,
      `unable:${s.ned.fullName}`,
      `status_update:${rita}`,
      `status_update:${rita}`,
      'ended',
    ]);
    // Zed did nothing: no response entries at all.
    expect(kinds(await all(s.zed.id, 'circle'))).toEqual([
      `alert_received:${rita}`,
      `status_update:${rita}`,
      `status_update:${rita}`,
      'ended',
    ]);
    // A member's "mine" is empty; "all" = circle.
    expect((await page(s.milo.id, '?category=mine')).entries).toEqual([]);
    expect(await all(s.milo.id)).toEqual(milo);
  });

  it('All mixes own alerts and circle alerts newest first; each entry keeps its own alert', async () => {
    const s = await scene();
    // Milo raises his own alert in his own circle, after Rita's.
    const miloCircle = await createCircle(client, s.milo);
    await addActiveMember(client, miloCircle, s.ned);
    const own = await submitAlert(app, s.milo.id, 'fire');
    expect(own.statusCode).toBe(201);
    const ownId = own.json<Body>().id as string;
    const entries = await all(s.milo.id, 'all', 3);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(entries.slice(0, 2).map((e) => [e.kind, e.category, e.incident.id])).toEqual([
      ['location_shared', 'mine', ownId],
      ['emergency_initiated', 'mine', ownId],
    ]);
    expect(entries.filter((e) => e.incident.id === s.incidentId)).toHaveLength(6);
    const sorted = [...entries].sort((a, b) =>
      a.occurred_at === b.occurred_at
        ? b.id.localeCompare(a.id)
        : Date.parse(b.occurred_at) - Date.parse(a.occurred_at),
    );
    expect(entries).toEqual(sorted);
    // Ned is a member of both circles: two received alerts from two circles.
    const ned = await all(s.ned.id, 'circle');
    expect(ned.filter((e) => e.kind === 'alert_received').map((e) => e.incident.id)).toEqual([
      ownId,
      s.incidentId,
    ]);
  });

  it('the automatic close is one ended {reason: "ended"} with no actor; the later Closed adds nothing', async () => {
    const s = await scene();
    // Rita's alert closes after the wrap-up: no second ended.
    await client.query(
      `update public.incidents set resolved_at = resolved_at - interval '2 hours' where id = $1`,
      [s.incidentId],
    );
    // A second alert left alone: closed automatically.
    const second = await submitAlert(app, s.rita.id, 'burglary');
    const secondId = second.json<Body>().id as string;
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(
      `update public.incidents
          set activated_at = activated_at - interval '30 hours', sent_at = sent_at - interval '30 hours',
              updated_at = updated_at - interval '30 hours'
        where id = $1`,
      [secondId],
    );
    // The memberships move back too, so the members stay inside the window.
    await client.query(
      `update public.safety_circle_members set activated_at = activated_at - interval '31 hours'
        where circle_id = $1 and activated_at is not null`,
      [s.circle.id],
    );
    await client.query('commit');
    await sweeper.sweep();
    const mine = await all(s.rita.id, 'mine');
    const ended = mine.filter((e) => e.kind === 'ended');
    expect(ended.map((e) => [e.incident.id, e.incident.status, e.detail, e.actor_name])).toEqual([
      [secondId, 'closed', { reason: 'ended' }, null],
      [s.incidentId, 'closed', { reason: 'safe' }, s.rita.fullName.trim()],
    ]);
    const milo = await all(s.milo.id, 'circle');
    expect(milo.filter((e) => e.kind === 'ended')).toHaveLength(2);
  });

  it('gap 59: every alert lists Location Shared strictly after Sent (never by the random id)', async () => {
    const rita = await createUser(client, { fullName: 'Gap Rita' });
    const circle = await createCircle(client, rita);
    const milo = await createUser(client, { fullName: 'Gap Milo' });
    await addActiveMember(client, circle, milo);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const reply = await submitAlert(app, rita.id, 'other');
      expect(reply.statusCode).toBe(201);
      const id = reply.json<Body>().id as string;
      ids.push(id);
      expect((await markSafe(app, rita.id, id)).statusCode).toBe(200);
    }
    const mine = await all(rita.id, 'mine');
    for (const id of ids) {
      const own = mine.filter((e) => e.incident.id === id);
      // Newest first: ended, location_shared, emergency_initiated; strictly later instants.
      expect(own.map((e) => e.kind)).toEqual(['ended', 'location_shared', 'emergency_initiated']);
      expect(own[1].occurred_at > own[2].occurred_at).toBe(true);
      const events = (await getIncidentEvents(app, rita.id, id)).json<Body[]>();
      expect(events.slice(0, 2).map((e) => e.event_type)).toEqual([
        'alert_sent',
        'location_sharing_started',
      ]);
    }
    const { rows } = await client.query<{ tied: number }>(
      `select count(*)::int as tied
         from public.incident_events a
         join public.incident_events b
           on b.incident_id = a.incident_id and b.event_type = 'location_sharing_started'
        where a.event_type = 'alert_sent' and a.incident_id = any($1::uuid[])
          and b.occurred_at <= a.occurred_at`,
      [ids],
    );
    expect(rows[0].tied).toBe(0);
  });

  it('pages by (occurred_at, id): same-instant events never repeat or skip', async () => {
    const s = await scene();
    const at = '2030-01-01T00:00:00.123456Z';
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.incident_events (incident_id, event_type, actor_id, detail, occurred_at)
         values ($1, 'status_update', $2, $3::jsonb, $4::timestamptz) returning id::text as id`,
        [s.incidentId, s.rita.id, JSON.stringify({ text: `same ${i}` }), at],
      );
      ids.push(rows[0].id);
    }
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const p = await page(
        s.milo.id,
        `?category=circle&limit=2${before ? `&before=${before}` : ''}`,
      );
      expect(p.entries.length).toBeLessThanOrEqual(2);
      seen.push(...p.entries.map((e) => e.id));
      before = p.next_cursor;
      pages++;
    } while (before);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 7)).toEqual([...ids].sort().reverse());
    expect(seen).toEqual((await all(s.milo.id, 'circle')).map((e) => e.id));
    expect(pages).toBe(Math.ceil(seen.length / 2));
    // The last page has no cursor; an exact fit has no extra empty page.
    const exact = await page(s.milo.id, `?category=circle&limit=${seen.length}`);
    expect(exact.next_cursor).toBeNull();
  });

  it('Stage 2 [B13]: a removed or departed member keeps the past alert read-only; an outsider and a later joiner see nothing', async () => {
    const s = await scene();
    const zedBefore = await all(s.zed.id);
    expect(zedBefore.length).toBeGreaterThan(0);
    const nedBefore = await all(s.ned.id);
    expect((await removeMember(app, s.rita.id, s.circle.id, s.zedRow.id)).statusCode).toBe(200);
    // The alert was resolved before the removal and he was notified of it: same entries as before.
    expect(await all(s.zed.id)).toEqual(zedBefore);
    expect((await leaveCircle(app, s.ned.id, s.circle.id)).statusCode).toBe(200);
    expect(await all(s.ned.id)).toEqual(nedBefore);
    expect(await all(s.outsider.id)).toEqual([]);
    const late = await createUser(client);
    await addActiveMember(client, s.circle, late);
    expect(await all(late.id)).toEqual([]);
    // Milo still sees it.
    expect((await all(s.milo.id)).length).toBe(6);
  });

  it('carries no user id anywhere', async () => {
    const s = await scene();
    for (const user of [s.rita, s.milo, s.ned]) {
      const text = (await activity(user.id, '?limit=50')).body;
      for (const id of [s.rita.id, s.milo.id, s.ned.id, s.zed.id, s.circle.id]) {
        expect(text).not.toContain(id);
      }
      const p = JSON.parse(text) as Page;
      for (const entry of p.entries) {
        const allowed = new Set([entry.id, entry.incident.id]);
        for (const match of JSON.stringify(entry).match(new RegExp(UUID, 'g')) ?? []) {
          expect(allowed.has(match)).toBe(true);
        }
        expect(Object.keys(entry).sort()).toEqual(
          ['actor_name', 'category', 'detail', 'id', 'incident', 'kind', 'occurred_at'].sort(),
        );
      }
    }
  });

  it('401 without a token; 422 for a bad category, cursor or limit (details.field)', async () => {
    const s = await scene();
    const unauth = await activity(null);
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json<{ error: { code: string } }>().error.code).toBe(
      'activity:not_authenticated',
    );
    const good = encodeActivityCursor({
      occurredAt: '2026-11-25T09:41:07.123456Z',
      id: randomUUID(),
    });
    for (const [query, field] of [
      ['?category=others', 'category'],
      ['?category=all&category=mine', 'category'],
      ['?before=abc%3D', 'before'],
      ['?before=bm90LWEtY3Vyc29y', 'before'],
      [
        `?before=${Buffer.from(`2026-11-31T00:00:00.000000Z|${randomUUID()}`).toString('base64url')}`,
        'before',
      ],
      ['?limit=0', 'limit'],
      ['?limit=51', 'limit'],
      ['?limit=x', 'limit'],
    ] as const) {
      const reply = await activity(s.rita.id, query);
      expect([query, reply.statusCode]).toEqual([query, 422]);
      expect(reply.json<{ error: { code: string; details: Body } }>().error).toMatchObject({
        code: 'validation:invalid_request',
        details: { field },
      });
    }
    // A well-formed cursor that matches no entry is fine (older than it = what is older).
    expect((await activity(s.rita.id, `?before=${good}`)).statusCode).toBe(200);
    // Default limit 30.
    const many = await page(s.rita.id);
    expect(many.entries.length).toBeLessThanOrEqual(30);
  });
});
