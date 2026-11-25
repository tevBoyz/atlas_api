import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  createCircle,
  createIncident,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import {
  attachLocation,
  getIncidentDetails,
  getOpenIncident,
  listRecentIncidents,
  listResponderIncidents,
  markSafe,
  renotifyAlert,
  setIncidentNotes,
  submitAlert,
} from '../support/incident-api';

/**
 * SCRUM-68 (last-known location fallback), decision D74 (epic §18.1 P5): an `unavailable` report
 * never wipes the stored fix. It keeps the last coordinates, accuracy, capture time and source, and
 * only records since when live location is unavailable (`location_unavailable_since`, migration
 * 0023). With no fix ever stored it is stored as before (`location_source = 'unavailable'`, no
 * position). The next fix overwrites and clears the flag; the out-of-order guard is unchanged. Every
 * read with the location keys (attach, notes, the open read, re-notify, submit, mark safe, member
 * details) carries the kept fix and the flag, the same for every member.
 */
type Body = Record<string, unknown>;

const T0 = '2026-11-25T10:00:00.000001+00:00';
const T1 = '2026-11-25T10:05:00+00:00';
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const LOCATION_KEYS = [
  'location_source',
  'location_lat',
  'location_lng',
  'location_accuracy_m',
  'location_captured_at',
  'location_unavailable_since',
] as const;

const fix = (capturedAt: string, extra: Body = {}): Body => ({
  location_source: 'current',
  location_lat: 13.4549,
  location_lng: -16.579,
  location_accuracy_m: 12.5,
  location_captured_at: capturedAt,
  ...extra,
});

const locationOf = (body: Body): Body =>
  Object.fromEntries(LOCATION_KEYS.map((key) => [key, body[key]]));

describe('SCRUM-68 last-known location fallback (D74)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
      }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  /** A resident with `members` active members and a submitted SOS. */
  async function activeAlert(members = 2) {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const memberUsers: UserFixture[] = [];
    for (let i = 0; i < members; i++) {
      const user = await createUser(client);
      await addActiveMember(client, circle, user);
      memberUsers.push(user);
    }
    const submitted = await submitAlert(app, resident.id, 'medical');
    expect(submitted.statusCode).toBe(201);
    return { resident, memberUsers, incidentId: submitted.json<Body>().id as string };
  }

  const stored = async (incidentId: string) => {
    const { rows } = await client.query<Body>(
      `select location_source, location_lat, location_lng, location_accuracy_m,
              to_char(location_captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as captured,
              location_unavailable_since
         from public.incidents where id = $1`,
      [incidentId],
    );
    return rows[0];
  };

  const ping = async (residentId: string, incidentId: string, body: Body) => {
    const res = await attachLocation(app, residentId, incidentId, body);
    expect(res.statusCode).toBe(200);
    return res.json<Body>();
  };

  describe('migration 0023', () => {
    it('location_unavailable_since: nullable timestamptz; only on an incident with a location report', async () => {
      const { rows } = await client.query<Body>(
        `select data_type, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'incidents'
            and column_name = 'location_unavailable_since'`,
      );
      expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
      const resident = await createUser(client);
      const { id } = await createIncident(client, resident, null);
      await expect(
        client.query(
          `update public.incidents set location_unavailable_since = now() where id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'incidents_location_unavailable_since_shape',
      });
      // The old shape check is unchanged: `unavailable` still has no position columns.
      await expect(
        client.query(
          `update public.incidents set location_source = 'unavailable', location_lat = 1 where id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'incidents_location_shape' });
    });
  });

  describe('the write', () => {
    it('unavailable after a fix keeps the coordinates, accuracy, source and their time; sets since', async () => {
      const { resident, incidentId } = await activeAlert(1);
      const live = await ping(resident.id, incidentId, fix(T0));
      expect(live.location_unavailable_since).toBeNull();

      const before = Date.now();
      const body = await ping(resident.id, incidentId, { location_source: 'unavailable' });
      expect(locationOf(body)).toEqual({
        location_source: 'current',
        location_lat: 13.4549,
        location_lng: -16.579,
        location_accuracy_m: 12.5,
        location_captured_at: T0,
        location_unavailable_since: expect.stringMatching(TIMESTAMP) as unknown,
      });
      const since = Date.parse(body.location_unavailable_since as string);
      expect(since).toBeGreaterThanOrEqual(before - 5_000);
      expect(since).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(await stored(incidentId)).toMatchObject({
        location_source: 'current',
        location_lat: 13.4549,
        location_lng: -16.579,
        location_accuracy_m: 12.5,
        captured: '2026-11-25T10:00:00.000001',
      });
    });

    it('a last_known fix without accuracy is kept the same way', async () => {
      const { resident, incidentId } = await activeAlert(1);
      await ping(
        resident.id,
        incidentId,
        fix(T0, { location_source: 'last_known', location_accuracy_m: null }),
      );
      const body = await ping(resident.id, incidentId, { location_source: 'unavailable' });
      expect(body).toMatchObject({
        location_source: 'last_known',
        location_lat: 13.4549,
        location_accuracy_m: null,
        location_captured_at: T0,
        location_unavailable_since: expect.stringMatching(TIMESTAMP) as unknown,
      });
    });

    it('repeated unavailable reports keep the earliest since and the fix', async () => {
      const { resident, incidentId } = await activeAlert(1);
      await ping(resident.id, incidentId, fix(T0));
      const first = await ping(resident.id, incidentId, { location_source: 'unavailable' });
      const second = await ping(resident.id, incidentId, { location_source: 'unavailable' });
      expect(second.location_unavailable_since).toBe(first.location_unavailable_since);
      expect(locationOf(second)).toEqual(locationOf(first));
    });

    it('unavailable first (no fix ever stored): no position, as before; since set', async () => {
      const { resident, incidentId } = await activeAlert(1);
      const body = await ping(resident.id, incidentId, { location_source: 'unavailable' });
      expect(locationOf(body)).toEqual({
        location_source: 'unavailable',
        location_lat: null,
        location_lng: null,
        location_accuracy_m: null,
        location_captured_at: null,
        location_unavailable_since: expect.stringMatching(TIMESTAMP) as unknown,
      });
      const again = await ping(resident.id, incidentId, { location_source: 'unavailable' });
      expect(again.location_unavailable_since).toBe(body.location_unavailable_since);
      // The first fix after it is stored and clears the flag.
      const first = await ping(resident.id, incidentId, fix(T0));
      expect(locationOf(first)).toMatchObject({
        location_source: 'current',
        location_lat: 13.4549,
        location_captured_at: T0,
        location_unavailable_since: null,
      });
    });

    it.each(['current', 'last_known'] as const)(
      'a newer %s fix after unavailable overwrites and clears the flag (live again)',
      async (source) => {
        const { resident, incidentId } = await activeAlert(1);
        await ping(resident.id, incidentId, fix(T0));
        await ping(resident.id, incidentId, { location_source: 'unavailable' });
        const body = await ping(
          resident.id,
          incidentId,
          fix(T1, { location_source: source, location_lat: 13.5 }),
        );
        expect(locationOf(body)).toEqual({
          location_source: source,
          location_lat: 13.5,
          location_lng: -16.579,
          location_accuracy_m: 12.5,
          location_captured_at: T1,
          location_unavailable_since: null,
        });
        expect((await stored(incidentId)).location_unavailable_since).toBeNull();
      },
    );

    it('out-of-order: an older fix after unavailable is ignored (fix and flag kept); an equal one is stored', async () => {
      const { resident, incidentId } = await activeAlert(1);
      await ping(resident.id, incidentId, fix(T1));
      const unavailable = await ping(resident.id, incidentId, { location_source: 'unavailable' });
      const older = await ping(resident.id, incidentId, fix(T0, { location_lat: 50 }));
      expect(locationOf(older)).toEqual(locationOf(unavailable));
      expect(older.location_unavailable_since).not.toBeNull();
      const equal = await ping(resident.id, incidentId, fix(T1, { location_lat: 14 }));
      expect(equal).toMatchObject({ location_lat: 14, location_unavailable_since: null });
    });

    it('after mark safe an unavailable report is refused (not_open) and nothing changes', async () => {
      const { resident, incidentId } = await activeAlert(1);
      await ping(resident.id, incidentId, fix(T0));
      expect((await markSafe(app, resident.id, incidentId)).statusCode).toBe(200);
      const before = await stored(incidentId);
      const late = await attachLocation(app, resident.id, incidentId, {
        location_source: 'unavailable',
      });
      expect(late.statusCode).toBe(409);
      expect(await stored(incidentId)).toEqual(before);
    });
  });

  describe('every read keeps the last position with the flag; members see the same', () => {
    it('attach, notes, open read, re-notify, submit, member details (every member), mark safe', async () => {
      const { resident, memberUsers, incidentId } = await activeAlert(2);
      await ping(resident.id, incidentId, fix(T0));
      const unavailable = await ping(resident.id, incidentId, { location_source: 'unavailable' });
      const expected = locationOf(unavailable);
      expect(expected).toMatchObject({
        location_lat: 13.4549,
        location_captured_at: T0,
        location_unavailable_since: expect.stringMatching(TIMESTAMP) as unknown,
      });

      // Resident: set notes (IncidentShared), the open read, re-notify, a re-submit (IncidentLive / Send).
      const notes = await setIncidentNotes(app, resident.id, incidentId, {
        incident_notes: 'Gate',
      });
      expect(locationOf(notes.json<Body>())).toEqual(expected);
      const open = (await getOpenIncident(app, resident.id)).json<{ open_incident: Body }>();
      expect(locationOf(open.open_incident)).toEqual(expected);
      const renotified = await renotifyAlert(app, resident.id, incidentId);
      expect(renotified.statusCode).toBe(200);
      expect(locationOf(renotified.json<Body>())).toEqual(expected);
      const resubmit = await submitAlert(app, resident.id, 'medical');
      expect(resubmit.json<Body>()).toMatchObject({ submit_outcome: 'renotified' });
      expect(locationOf(resubmit.json<Body>())).toEqual(expected);

      // Members: the details read, identical for every member.
      for (const member of memberUsers) {
        const details = await getIncidentDetails(app, member.id, incidentId);
        expect(details.statusCode).toBe(200);
        expect(locationOf(details.json<Body>())).toEqual(expected);
      }
      // The lists carry no location (unchanged).
      const list = (await listResponderIncidents(app, memberUsers[0].id)).json<Body[]>();
      expect(list.find((item) => item.id === incidentId)).not.toHaveProperty('location_lat');
      const recent = (await listRecentIncidents(app, resident.id)).json<Body[]>();
      expect(recent[0]).not.toHaveProperty('location_unavailable_since');

      // Mark safe (IncidentSend) and the member read afterwards keep the last position.
      const safe = await markSafe(app, resident.id, incidentId);
      expect(safe.statusCode).toBe(200);
      expect(locationOf(safe.json<Body>())).toEqual(expected);
      const afterClose = await getIncidentDetails(app, memberUsers[1].id, incidentId);
      expect(locationOf(afterClose.json<Body>())).toEqual(expected);
    });

    it('a live incident without any unavailable report carries location_unavailable_since null everywhere', async () => {
      const { resident, memberUsers, incidentId } = await activeAlert(1);
      expect(
        locationOf(
          (await getOpenIncident(app, resident.id)).json<{ open_incident: Body }>().open_incident,
        ),
      ).toEqual({
        location_source: null,
        location_lat: null,
        location_lng: null,
        location_accuracy_m: null,
        location_captured_at: null,
        location_unavailable_since: null,
      });
      await ping(resident.id, incidentId, fix(T0));
      const details = (await getIncidentDetails(app, memberUsers[0].id, incidentId)).json<Body>();
      expect(details).toMatchObject({ location_lat: 13.4549, location_unavailable_since: null });
    });
  });
});
