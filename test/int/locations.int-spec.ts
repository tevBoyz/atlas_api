import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { RATE_LIMIT_KEY_PREFIX } from '../../src/common/rate-limit';
import {
  INCIDENT_POST_COMMIT_HOOKS,
  type IncidentLocationEvent,
} from '../../src/modules/incidents/incident-post-commit';
import { isPostgresUuidInput } from '../../src/modules/incidents/incident-input';
import { LocationsRepository } from '../../src/modules/locations/locations.repository';
import { RedisService } from '../../src/redis';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
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
  countRows,
  getLiveLocationConfig,
  getOpenIncident,
  markSafe,
  submitAlert,
} from '../support/incident-api';

/**
 * `POST /v1/incidents/{id}/locations` (API-100-17): argument conversion and check order, the
 * out-of-order guard at microsecond precision, AC7 (nothing but the five location columns
 * changes), the post-commit hook, coordinates kept out of logs, the rate-limit budget of an active
 * alert, and races on separate connections.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof attachLocation>>;

const INCIDENT_SHARED_KEYS = [
  'activated_at',
  'activity_confirmed_at',
  'auto_closed',
  'cancelled_at',
  'circle_id',
  'country_code', // Stage 2 [B9]
  'emergency_type',
  'id',
  'incident_notes',
  'incident_notes_updated_at',
  'location_accuracy_m',
  'location_captured_at',
  'location_lat',
  'location_lng',
  'location_sharing_ended_at',
  'location_source',
  'location_unavailable_since',
  'place_name', // Stage 2 [B6]
  'renotified_at',
  'resident_id',
  'resolved_at',
  'resolved_reason',
  'sent_at',
  'share_payload',
  'status',
];
/** The stored fix every guard case starts from: one microsecond past 10:00 UTC. */
const T0 = '2026-11-19T10:00:00.000001+00:00';
const PARALLEL = 10;

let hookBehaviour: (event: IncidentLocationEvent) => void | Promise<void>;
const hookCalls: IncidentLocationEvent[] = [];

describe('POST /v1/incidents/{id}/locations (API-100-17)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({}, (builder) =>
      withTestConfig({ DATABASE_POOL_MAX: String(PARALLEL * 2) })(builder)
        .overrideProvider(INCIDENT_POST_COMMIT_HOOKS)
        .useValue([
          {
            afterLocation: (event: IncidentLocationEvent) => {
              hookCalls.push(event);
              return hookBehaviour(event);
            },
          },
        ]),
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
    hookBehaviour = () => undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const errorOf = (reply: Reply) => reply.json<{ error: { code: string; details: Body } }>().error;

  /** A resident with an active incident created through the API (deliveries and events included). */
  async function activeAlert(members = 1) {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const memberUsers: UserFixture[] = [];
    for (let i = 0; i < members; i++) {
      const user = await createUser(client);
      await addActiveMember(client, circle, user);
      memberUsers.push(user);
    }
    const incident = (await submitAlert(app, resident.id, 'fire')).json<Body>();
    return { resident, circle, memberUsers, incidentId: incident.id as string };
  }

  /** A bare active incident with a stored `current` fix at {@link T0}. */
  async function incidentWithFix(): Promise<{ resident: UserFixture; incidentId: string }> {
    const resident = await createUser(client);
    const { id } = await createIncident(client, resident, null);
    await client.query(
      `update public.incidents
          set location_source = 'current', location_lat = 1, location_lng = 1,
              location_accuracy_m = 5, location_captured_at = $2
        where id = $1`,
      [id, T0],
    );
    return { resident, incidentId: id };
  }

  const storedLocation = async (incidentId: string) => {
    const { rows } = await client.query<Body>(
      `select location_source, location_lat, location_lng, location_accuracy_m,
              to_char(location_captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as captured
         from public.incidents where id = $1`,
      [incidentId],
    );
    return rows[0];
  };

  const fix = (capturedAt: string, extra: Body = {}) => ({
    location_source: 'current',
    location_lat: 9.03,
    location_lng: 38.74,
    location_accuracy_m: 12.5,
    location_captured_at: capturedAt,
    ...extra,
  });

  describe('AC1-AC2: authentication and the happy path', () => {
    it('without a token: 401 attach_incident_location:not_authenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/incidents/${randomUUID()}/locations`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(fix(T0)),
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('attach_incident_location:not_authenticated');
    });

    it('stores a current fix and answers IncidentShared (22 keys + D74)', async () => {
      const { resident, incidentId } = await activeAlert();
      const res = await attachLocation(app, resident.id, incidentId, fix(T0));

      expect(res.statusCode).toBe(200);
      const body = res.json<Body>();
      expect(Object.keys(body).sort()).toEqual(INCIDENT_SHARED_KEYS);
      expect(body).toMatchObject({
        id: incidentId,
        status: 'active',
        location_source: 'current',
        location_lat: 9.03,
        location_lng: 38.74,
        location_accuracy_m: 12.5,
        location_captured_at: T0,
      });
    });

    it('the open-incident read reflects the location update', async () => {
      const { resident, incidentId } = await activeAlert(2);
      await attachLocation(app, resident.id, incidentId, fix(T0));
      const open = (await getOpenIncident(app, resident.id)).json<{ open_incident: Body }>()
        .open_incident;
      expect(open).toMatchObject({
        id: incidentId,
        location_lat: 9.03,
        location_lng: 38.74,
        location_captured_at: T0,
        delivered_count: 2,
      });

      await attachLocation(app, resident.id, incidentId, { location_source: 'unavailable' });
      const after = (await getOpenIncident(app, resident.id)).json<{ open_incident: Body }>()
        .open_incident;
      // SCRUM-68 (D74): the last fix is kept; only since when live location is unavailable is new.
      expect(after).toMatchObject({
        location_source: 'current',
        location_lat: 9.03,
        location_lng: 38.74,
        location_captured_at: T0,
        location_unavailable_since: expect.any(String) as unknown,
      });
    });

    it('the config endpoint answers any valid token (no profile needed)', async () => {
      const noProfile = await createUser(client, { profile: false });
      const res = await getLiveLocationConfig(app, noProfile.id);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('AC3: argument conversion and checks', () => {
    type Expect = 'ok' | 'type_error' | 'invalid_source' | 'invalid_location';
    /** [name, exact JSON body text, expected outcome, field named by a type error]. */
    const CASES: [string, string, Expect, string?][] = [
      ['empty object', '{}', 'invalid_source'],
      ['source null', '{"location_source":null}', 'invalid_source'],
      [
        'source in capitals',
        '{"location_source":"CURRENT","location_lat":1,"location_lng":1,"location_accuracy_m":1,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_source',
      ],
      ['source with a space', '{"location_source":" current"}', 'invalid_source'],
      ['source a number', '{"location_source":5}', 'invalid_source'],
      ['source a boolean', '{"location_source":true}', 'invalid_source'],
      ['source an object', '{"location_source":{"a":1}}', 'invalid_source'],
      ['source an array', '{"location_source":["current"]}', 'invalid_source'],
      [
        'bad source and unconvertible lat: conversion first',
        '{"location_source":"bogus","location_lat":"abc"}',
        'type_error',
        'location_lat',
      ],
      ['unavailable alone', '{"location_source":"unavailable"}', 'ok'],
      [
        'unavailable with explicit nulls',
        '{"location_source":"unavailable","location_lat":null,"location_lng":null,"location_accuracy_m":null,"location_captured_at":null}',
        'ok',
      ],
      [
        'unavailable with lat',
        '{"location_source":"unavailable","location_lat":1}',
        'invalid_location',
      ],
      [
        'unavailable with accuracy 0',
        '{"location_source":"unavailable","location_accuracy_m":0}',
        'invalid_location',
      ],
      [
        'unavailable with captured_at',
        '{"location_source":"unavailable","location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'unavailable with lng "NaN"',
        '{"location_source":"unavailable","location_lng":"NaN"}',
        'invalid_location',
      ],
      [
        'current, all fields',
        '{"location_source":"current","location_lat":9.03,"location_lng":38.74,"location_accuracy_m":12.5,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'current without lat',
        '{"location_source":"current","location_lng":1,"location_accuracy_m":1,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'current without captured_at',
        '{"location_source":"current","location_lat":1,"location_lng":1,"location_accuracy_m":1}',
        'invalid_location',
      ],
      [
        'current without accuracy',
        '{"location_source":"current","location_lat":1,"location_lng":1,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'current with accuracy null',
        '{"location_source":"current","location_lat":1,"location_lng":1,"location_accuracy_m":null,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'last_known without accuracy',
        '{"location_source":"last_known","location_lat":1,"location_lng":1,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'lat 90 / lng 180',
        '{"location_source":"last_known","location_lat":90,"location_lng":180,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'lat -90 / lng -180',
        '{"location_source":"last_known","location_lat":-90,"location_lng":-180,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'lat 90.0000001',
        '{"location_source":"last_known","location_lat":90.0000001,"location_lng":1,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'lng -180.000001',
        '{"location_source":"last_known","location_lat":1,"location_lng":-180.000001,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'accuracy -0.001',
        '{"location_source":"current","location_lat":1,"location_lng":1,"location_accuracy_m":-0.001,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'accuracy -0',
        '{"location_source":"current","location_lat":1,"location_lng":1,"location_accuracy_m":-0,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'accuracy 0, lat -0.0',
        '{"location_source":"current","location_lat":-0.0,"location_lng":1,"location_accuracy_m":0,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'lat as a numeric string',
        '{"location_source":"last_known","location_lat":"9.03","location_lng":"38.74","location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'lat as a padded string',
        '{"location_source":"last_known","location_lat":" 9.03 ","location_lng":"1e1","location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'lat 1.5e1 and a long fraction',
        '{"location_source":"last_known","location_lat":1.5e1,"location_lng":38.740000000000000001,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'lat "NaN"',
        '{"location_source":"last_known","location_lat":"NaN","location_lng":1,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'lat "Infinity"',
        '{"location_source":"last_known","location_lat":"Infinity","location_lng":1,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'lng "-Infinity"',
        '{"location_source":"last_known","location_lat":1,"location_lng":"-Infinity","location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'lat "inf"',
        '{"location_source":"last_known","location_lat":"inf","location_lng":1,"location_captured_at":"2026-11-19T11:00:00Z"}',
        'invalid_location',
      ],
      [
        'accuracy "NaN" (stored)',
        '{"location_source":"current","location_lat":1,"location_lng":1,"location_accuracy_m":"NaN","location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'accuracy "Infinity"',
        '{"location_source":"current","location_lat":1,"location_lng":1,"location_accuracy_m":"Infinity","location_captured_at":"2026-11-19T11:00:00Z"}',
        'ok',
      ],
      [
        'lat "abc"',
        '{"location_source":"current","location_lat":"abc"}',
        'type_error',
        'location_lat',
      ],
      [
        'lat empty string',
        '{"location_source":"current","location_lat":""}',
        'type_error',
        'location_lat',
      ],
      [
        'lat a boolean',
        '{"location_source":"current","location_lat":true}',
        'type_error',
        'location_lat',
      ],
      [
        'lng an object',
        '{"location_source":"current","location_lng":{}}',
        'type_error',
        'location_lng',
      ],
      [
        'accuracy an array',
        '{"location_source":"current","location_accuracy_m":[1]}',
        'type_error',
        'location_accuracy_m',
      ],
      [
        'lat 1e400 (out of range)',
        '{"location_source":"current","location_lat":1e400}',
        'type_error',
        'location_lat',
      ],
      [
        'lng "1e400"',
        '{"location_source":"current","location_lng":"1e400"}',
        'type_error',
        'location_lng',
      ],
      [
        'lat and lng both bad: lat named',
        '{"location_source":"current","location_lat":"x","location_lng":"y"}',
        'type_error',
        'location_lat',
      ],
      [
        'captured_at not a date',
        '{"location_source":"current","location_captured_at":"not a date"}',
        'type_error',
        'location_captured_at',
      ],
      [
        'captured_at empty',
        '{"location_source":"current","location_captured_at":""}',
        'type_error',
        'location_captured_at',
      ],
      [
        'captured_at 30 February',
        '{"location_source":"current","location_captured_at":"2026-02-30T00:00:00Z"}',
        'type_error',
        'location_captured_at',
      ],
      [
        'captured_at without an offset (UTC)',
        '{"location_source":"last_known","location_lat":1,"location_lng":1,"location_captured_at":"2026-11-19 11:00"}',
        'ok',
      ],
      [
        'captured_at with +03:00',
        '{"location_source":"last_known","location_lat":1,"location_lng":1,"location_captured_at":"2026-11-19T12:00:00+03:00"}',
        'ok',
      ],
      [
        'captured_at month-first',
        '{"location_source":"last_known","location_lat":1,"location_lng":1,"location_captured_at":"12/01/2026 10:00"}',
        'ok',
      ],
      [
        'captured_at "infinity"',
        '{"location_source":"last_known","location_lat":1,"location_lng":1,"location_captured_at":"infinity"}',
        'ok',
      ],
      [
        'captured_at "-infinity" (older: ignored)',
        '{"location_source":"last_known","location_lat":2,"location_lng":2,"location_captured_at":"-infinity"}',
        'ok',
      ],
      [
        'captured_at with 7 fractional digits',
        '{"location_source":"last_known","location_lat":3,"location_lng":3,"location_captured_at":"2026-11-19T10:00:00.0000015Z"}',
        'ok',
      ],
      ['source with NUL', '{"location_source":"current\\u0000"}', 'type_error', 'location_source'],
      [
        'source with an unpaired surrogate',
        '{"location_source":"\\ud800"}',
        'type_error',
        'location_source',
      ],
      [
        'lat with NUL',
        '{"location_source":"current","location_lat":"1\\u0000"}',
        'type_error',
        'location_lat',
      ],
      [
        'unknown keys are ignored',
        '{"location_source":"unavailable","foo":1,"p_location_lat":5}',
        'ok',
      ],
    ];

    const apiOutcome = (reply: Reply): { kind: string; body?: Body; field?: unknown } => {
      if (reply.statusCode === 200) return { kind: 'ok', body: reply.json<Body>() };
      const error = errorOf(reply);
      if (error.code === 'validation:invalid_request') {
        expect(reply.statusCode).toBe(422);
        return { kind: 'type_error', field: error.details.field };
      }
      expect(reply.statusCode).toBe(422);
      return { kind: error.code.replace('attach_incident_location:', '') };
    };
    it.each(CASES)('%s', async (_name, json, expected, ...rest) => {
      const field = rest[0];
      const viaApi = await incidentWithFix();
      const before = await storedLocation(viaApi.incidentId);

      const api = apiOutcome(
        await attachLocation(app, viaApi.resident.id, viaApi.incidentId, json),
      );

      expect(api.kind).toBe(expected);
      if (field) expect(api.field).toBe(field);
      if (api.kind !== 'ok') {
        // A refused ping writes nothing.
        expect(await storedLocation(viaApi.incidentId)).toEqual(before);
        return;
      }
      if (api.body?.location_unavailable_since) {
        // SCRUM-68 (D74): an accepted `unavailable` report keeps the stored fix and records since
        // when live location is unavailable.
        expect(api.body).toMatchObject({
          location_source: 'current',
          location_lat: 1,
          location_captured_at: T0,
          location_unavailable_since: expect.any(String) as unknown,
        });
        expect(await storedLocation(viaApi.incidentId)).toEqual(before);
        return;
      }
      // An accepted fix: the answer shows what was stored (as text: -0 is 0, NaN / Infinity are
      // the strings the answer carries).
      const stored = await storedLocation(viaApi.incidentId);
      const keys = ['location_source', 'location_lat', 'location_lng', 'location_accuracy_m'];
      const pick = (row: Body | undefined) =>
        keys.map((key) => {
          const value = (row ?? {})[key];
          if (value === null || value === undefined) return null;
          return typeof value === 'number' || typeof value === 'string'
            ? String(value)
            : JSON.stringify(value);
        });
      expect(pick(api.body)).toEqual(pick(stored));
    });

    it.each([
      ['an array', '[]'],
      ['a string', '"current"'],
      ['null', 'null'],
    ])('a body that is %s is 422 on field body', async (_name, json) => {
      const { resident, incidentId } = await incidentWithFix();
      const res = await attachLocation(app, resident.id, incidentId, json);
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'body' },
      });
    });

    it('checks run before any lookup: an unknown incident still gets the argument error', async () => {
      const { id } = await createUser(client);
      const unknown = randomUUID();
      expect(errorOf(await attachLocation(app, id, unknown, {})).code).toBe(
        'attach_incident_location:invalid_source',
      );
      expect(
        errorOf(await attachLocation(app, id, unknown, { location_source: 'current' })).code,
      ).toBe('attach_incident_location:invalid_location');
      expect(
        errorOf(await attachLocation(app, id, unknown, { location_source: 'unavailable' })).code,
      ).toBe('attach_incident_location:not_found');
    });

    it("someone else's incident: argument errors first, then not_found", async () => {
      const { incidentId } = await incidentWithFix();
      const other = await createUser(client);
      expect(errorOf(await attachLocation(app, other.id, incidentId, {})).code).toBe(
        'attach_incident_location:invalid_source',
      );
      expect(errorOf(await attachLocation(app, other.id, incidentId, fix(T0))).code).toBe(
        'attach_incident_location:not_found',
      );
    });

    it('a closed incident: argument errors first, then not_open', async () => {
      const { resident, incidentId } = await activeAlert();
      await markSafe(app, resident.id, incidentId);
      expect(
        errorOf(
          await attachLocation(app, resident.id, incidentId, {
            location_source: 'unavailable',
            location_lat: 1,
          }),
        ).code,
      ).toBe('attach_incident_location:invalid_location');
      const res = await attachLocation(app, resident.id, incidentId, fix(T0));
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('attach_incident_location:not_open');
    });
  });

  describe('the {id} path parameter', () => {
    it.each([
      ['not a uuid', 'abc'],
      ['one digit short', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1'],
      ['a trailing hyphen', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11-'],
      ['two hyphens in a row', 'a0eebc99--9c0b-4ef8-bb6d-6bb9bd380a11'],
      ['an unclosed brace', '%7Ba0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
      ['a space', '%20a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
    ])('%s → 422 on field id, before the body is read', async (_name, id) => {
      const { id: userId } = await createUser(client);
      const res = await attachLocation(app, userId, id, '[]');
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'id' },
      });
      // Postgres refuses the same text as a uuid.
      await expect(client.query('select $1::uuid', [decodeURIComponent(id)])).rejects.toMatchObject(
        { code: '22P02' },
      );
    });

    it('every spelling Postgres accepts reaches the same incident', async () => {
      const { resident, incidentId } = await incidentWithFix();
      const hex = incidentId.replace(/-/g, '');
      for (const spelling of [
        incidentId.toUpperCase(),
        hex,
        `%7B${incidentId}%7D`,
        `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 24)}-${hex.slice(24, 28)}-${hex.slice(28)}`,
      ]) {
        const res = await attachLocation(app, resident.id, spelling, {
          location_source: 'unavailable',
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<Body>().id).toBe(incidentId);
      }
    });

    it('the grammar matches Postgres uuid input on a corpus', async () => {
      const base = 'a0eebc999c0b4ef8bb6d6bb9bd380a11';
      const corpus = [
        base,
        base.toUpperCase(),
        `{${base}}`,
        `{${base}`,
        `${base}}`,
        `-${base}`,
        `${base}-`,
        `a0ee-${base.slice(4)}`,
        `a0e-e${base.slice(4)}`,
        `a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`,
        `a0eebc99-9c0b4ef8-bb6d6bb9-bd380a11`,
        `a0eebc99--9c0b-4ef8-bb6d-6bb9bd380a11`,
        `${base}0`,
        base.slice(1),
        `g${base.slice(1)}`,
        ` ${base}`,
        `${base} `,
        '',
        '{}',
        `{a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11}`,
      ];
      const { rows } = await client.query<{ valid: boolean }>(
        'select pg_input_is_valid(v, $2) as valid from unnest($1::text[]) as v',
        [corpus, 'uuid'],
      );
      expect(corpus.map(isPostgresUuidInput)).toEqual(rows.map((r) => r.valid));
    });
  });

  describe("AC4: the incident must be the caller's, active, sharing not ended", () => {
    it("unknown, another resident's, or a member viewing it: 404 not_found", async () => {
      const { resident, memberUsers, incidentId } = await activeAlert();
      const outsider = await createUser(client);
      for (const [userId, id] of [
        [resident.id, randomUUID()],
        [outsider.id, incidentId],
        [memberUsers[0].id, incidentId],
      ]) {
        const res = await attachLocation(app, userId, id, fix(T0));
        expect(res.statusCode).toBe(404);
        expect(errorOf(res).code).toBe('attach_incident_location:not_found');
      }
    });

    it.each(['cancelled', 'activating'])('a legacy %s incident: 409 not_open', async (status) => {
      const resident = await createUser(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into public.incidents (resident_id, status, emergency_type, cancelled_at)
         values ($1, $2, 'unspecified', case when $2 = 'cancelled' then now() end) returning id`,
        [resident.id, status],
      );
      const res = await attachLocation(app, resident.id, rows[0].id, fix(T0));
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('attach_incident_location:not_open');
    });

    it('a late ping after close: not_open, and nothing reopens or changes', async () => {
      const { resident, incidentId } = await activeAlert(2);
      await attachLocation(app, resident.id, incidentId, fix(T0));
      await markSafe(app, resident.id, incidentId);
      const snapshot = async () => ({
        incident: (await client.query('select * from public.incidents where id = $1', [incidentId]))
          .rows,
        events: (
          await client.query(
            'select event_type, detail from public.incident_events where incident_id = $1 order by event_type',
            [incidentId],
          )
        ).rows,
        deliveries: (
          await client.query(
            'select * from public.incident_deliveries where incident_id = $1 order by id',
            [incidentId],
          )
        ).rows,
      });
      const before = await snapshot();

      for (const body of [
        fix('2026-11-19T12:00:00Z', { location_lat: 1, location_lng: 1 }),
        { location_source: 'unavailable' },
        fix('2099-01-01T00:00:00Z'),
      ]) {
        const res = await attachLocation(app, resident.id, incidentId, body);
        expect(res.statusCode).toBe(409);
        expect(errorOf(res).code).toBe('attach_incident_location:not_open');
      }

      expect(await snapshot()).toEqual(before);
      expect(before.incident[0]).toMatchObject({ status: 'resolved', location_lat: 9.03 });
      expect((await getOpenIncident(app, resident.id)).json()).toEqual({ open_incident: null });
      expect(hookCalls.map((e) => e.incident_id)).toEqual([incidentId]);
    });
  });

  describe('AC5: out-of-order guard, compared in Postgres', () => {
    it('one microsecond older is ignored (a JS Date would see the same millisecond)', async () => {
      const { resident, incidentId } = await incidentWithFix();
      const res = await attachLocation(
        app,
        resident.id,
        incidentId,
        fix('2026-11-19T10:00:00.000000Z', { location_lat: 50 }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json<Body>()).toMatchObject({ location_lat: 1, location_captured_at: T0 });
      expect(hookCalls).toEqual([]);
    });

    it('equal overwrites; one microsecond newer overwrites', async () => {
      const { resident, incidentId } = await incidentWithFix();
      const equal = await attachLocation(
        app,
        resident.id,
        incidentId,
        fix(T0, { location_lat: 50 }),
      );
      expect(equal.json<Body>()).toMatchObject({ location_lat: 50, location_captured_at: T0 });

      const newer = await attachLocation(
        app,
        resident.id,
        incidentId,
        fix('2026-11-19T10:00:00.000002Z', { location_lat: 51 }),
      );
      expect(newer.json<Body>()).toMatchObject({
        location_lat: 51,
        location_captured_at: '2026-11-19T10:00:00.000002+00:00',
      });
    });

    it('the same instant in another offset is equal (overwrites)', async () => {
      const { resident, incidentId } = await incidentWithFix();
      const res = await attachLocation(
        app,
        resident.id,
        incidentId,
        fix('2026-11-19T13:00:00.000001+03:00', { location_lat: 52 }),
      );
      expect(res.json<Body>()).toMatchObject({ location_lat: 52, location_captured_at: T0 });
    });

    it('unavailable keeps the stored fix (D74); an older fix after it is still ignored', async () => {
      const { resident, incidentId } = await incidentWithFix();
      const unavailable = await attachLocation(app, resident.id, incidentId, {
        location_source: 'unavailable',
      });
      expect(unavailable.json<Body>()).toMatchObject({
        location_source: 'current',
        location_lat: 1,
        location_lng: 1,
        location_accuracy_m: 5,
        location_captured_at: T0,
        location_unavailable_since: expect.any(String) as unknown,
      });
      const older = await attachLocation(app, resident.id, incidentId, fix('2020-01-01T00:00:00Z'));
      expect(older.json<Body>()).toMatchObject({
        location_source: 'current',
        location_lat: 1,
        location_captured_at: T0,
        location_unavailable_since: unavailable.json<Body>().location_unavailable_since,
      });
    });

    it('a stored fix without captured_at (legacy rows cannot have one) never blocks', async () => {
      const resident = await createUser(client);
      const { id } = await createIncident(client, resident, null);
      const res = await attachLocation(app, resident.id, id, fix('2000-01-01T00:00:00Z'));
      expect(res.json<Body>()).toMatchObject({ location_lat: 9.03 });
    });
  });

  describe('AC7: never notifies, never touches deliveries, status, type or notes', () => {
    it('only the five location columns (and updated_at) change, for every kind of ping', async () => {
      const { resident, memberUsers, incidentId } = await activeAlert(2);
      await client.query(
        `update public.incidents set incident_notes = 'Gate code 1234', incident_notes_updated_at = now()
          where id = $1`,
        [incidentId],
      );
      await client.query(
        `update public.incident_deliveries set acknowledged_at = now()
          where incident_id = $1 and member_user_id = $2`,
        [incidentId, memberUsers[0].id],
      );
      const LOCATION = [
        'location_source',
        'location_lat',
        'location_lng',
        'location_accuracy_m',
        'location_captured_at',
        'location_unavailable_since', // SCRUM-68 (D74)
        'updated_at',
      ];
      const snapshot = async () => {
        const incident = (
          await client.query<Body>('select * from public.incidents where id = $1', [incidentId])
        ).rows[0];
        for (const key of LOCATION) delete incident[key];
        return {
          incident,
          deliveries: (
            await client.query(
              'select * from public.incident_deliveries where incident_id = $1 order by id',
              [incidentId],
            )
          ).rows,
          events: (
            await client.query(
              'select * from public.incident_events where incident_id = $1 order by id',
              [incidentId],
            )
          ).rows,
          audit: await countRows(
            client,
            'select count(*)::int as n from public.audit_log where target_id = $1',
            [incidentId],
          ),
          incidents: await countRows(
            client,
            'select count(*)::int as n from public.incidents where resident_id = $1',
            [resident.id],
          ),
        };
      };
      const before = await snapshot();

      for (const body of [
        fix(T0),
        fix('2026-11-19T09:00:00Z'), // older: ignored
        { location_source: 'unavailable' },
        fix('2026-11-19T11:00:00Z', { location_source: 'last_known', location_accuracy_m: null }),
        { location_source: 'current' }, // invalid_location
        { location_source: 'x' }, // invalid_source
      ]) {
        await attachLocation(app, resident.id, incidentId, body);
      }

      expect(await snapshot()).toEqual(before);
    });
  });

  describe('AC8: post-commit hook incident.location', () => {
    it('runs after a stored ping with ids only; not for an ignored ping or an error', async () => {
      const { resident, circle, incidentId } = await activeAlert();
      await attachLocation(app, resident.id, incidentId, fix(T0));
      await attachLocation(app, resident.id, incidentId, fix('2026-11-19T09:00:00Z'));
      await attachLocation(app, resident.id, incidentId, { location_source: 'current' });
      await attachLocation(app, resident.id, randomUUID(), fix(T0));

      expect(hookCalls).toEqual([
        { incident_id: incidentId, resident_id: resident.id, circle_id: circle.id },
      ]);
    });

    it('a failing or hanging hook changes nothing for the caller', async () => {
      const { resident, incidentId } = await activeAlert();
      hookBehaviour = () => Promise.reject(new Error('realtime down'));
      expect((await attachLocation(app, resident.id, incidentId, fix(T0))).statusCode).toBe(200);
      hookBehaviour = () => new Promise(() => undefined);
      const res = await attachLocation(app, resident.id, incidentId, fix('2026-11-19T11:00:00Z'));
      expect(res.statusCode).toBe(200);
    });
  });

  describe('coordinates never reach logs, audit or errors', () => {
    const LAT = 12.3456789;
    const LNG = -45.6789012;
    const ACCURACY = 7.7777777;
    const secrets = ['12.3456789', '45.6789012', '7.7777777'];
    const coordinates = (capturedAt: string) =>
      fix(capturedAt, { location_lat: LAT, location_lng: LNG, location_accuracy_m: ACCURACY });

    it('success, ignored, rejected, closed and a database failure', async () => {
      const { resident, incidentId } = await activeAlert();
      const start = logs.text.length;
      const replies: Reply[] = [];
      replies.push(await attachLocation(app, resident.id, incidentId, coordinates(T0)));
      replies.push(
        await attachLocation(app, resident.id, incidentId, coordinates('2026-11-19T09:00:00Z')),
      );
      replies.push(
        await attachLocation(app, resident.id, incidentId, {
          ...coordinates(T0),
          location_source: 'unavailable',
        }),
      );
      replies.push(
        await attachLocation(app, resident.id, incidentId, {
          ...coordinates(T0),
          location_lat: '12.3456789x',
        }),
      );
      jest.spyOn(app.get(LocationsRepository), 'writeLocation').mockRejectedValueOnce(
        Object.assign(new Error(`Failed query: update params: ${LAT},${LNG},${ACCURACY}`), {
          code: '23514',
        }),
      );
      const failed = await attachLocation(
        app,
        resident.id,
        incidentId,
        coordinates('2026-11-19T12:00:00Z'),
      );
      expect(failed.statusCode).toBe(500);
      expect(errorOf(failed).code).toBe('internal:error');
      replies.push(failed);
      await markSafe(app, resident.id, incidentId);
      replies.push(
        await attachLocation(app, resident.id, incidentId, coordinates('2026-11-19T13:00:00Z')),
      );

      const logged = logs.text.slice(start);
      expect(logged).toContain('unexpected error');
      for (const secret of secrets) {
        expect(logged).not.toContain(secret);
        for (const reply of replies.slice(2)) expect(reply.body).not.toContain(secret);
      }
      const { rows } = await client.query<{ detail: unknown }>(
        'select detail from public.audit_log where target_id = $1',
        [incidentId],
      );
      expect(JSON.stringify(rows)).not.toMatch(/12\.345|45\.678|7\.777/);
    });
  });

  describe('rate limits', () => {
    let redis: RedisService;
    beforeAll(() => {
      redis = app.get(RedisService);
    });

    it('location pings count under their own policy, per user per incident', async () => {
      const { resident, incidentId } = await activeAlert();
      await attachLocation(app, resident.id, incidentId, fix(T0));
      expect(
        await redis.client.zcard(
          `${RATE_LIMIT_KEY_PREFIX}:location_ping:u:${resident.id}:i:${incidentId}`,
        ),
      ).toBe(1);
    });

    it('one minute of an active alert stays well under every limit', async () => {
      // Per minute: a ping every 12 s (5), the delivery-counts poll every 2 s (30, stood in for by
      // the open read until API-100-20), open-incident rechecks after timeouts (5, generous) and the
      // config read (1). Default limits: location_ping 30 / 60 s per incident, authenticated 300 / 60 s.
      const { resident, incidentId } = await activeAlert(5);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push(
          (
            await attachLocation(
              app,
              resident.id,
              incidentId,
              fix(`2026-11-19T10:00:${String(i * 12).padStart(2, '0')}Z`),
            )
          ).statusCode,
        );
      }
      for (let i = 0; i < 35; i++)
        statuses.push((await getOpenIncident(app, resident.id)).statusCode);
      statuses.push((await getLiveLocationConfig(app, resident.id)).statusCode);

      expect(statuses.filter((s) => s !== 200)).toEqual([]);
      const pings = await redis.client.zcard(
        `${RATE_LIMIT_KEY_PREFIX}:location_ping:u:${resident.id}:i:${incidentId}`,
      );
      const general = await redis.client.zcard(
        `${RATE_LIMIT_KEY_PREFIX}:authenticated:u:${resident.id}`,
      );
      expect(pings).toBe(5); // of 30
      // The submit counted under emergency_write; pings also count under the general budget.
      expect(general).toBe(41); // of 300
    });

    it('the 31st ping to one incident within a minute is 429; another incident is separate', async () => {
      const { resident, incidentId } = await activeAlert();
      for (let i = 0; i < 30; i++) {
        expect(
          (await attachLocation(app, resident.id, incidentId, { location_source: 'unavailable' }))
            .statusCode,
        ).toBe(200);
      }
      const limited = await attachLocation(app, resident.id, incidentId, {
        location_source: 'unavailable',
      });
      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limit:exceeded');
      expect(limited.headers['retry-after']).toBeDefined();
      const other = await incidentWithFix();
      expect(
        (
          await attachLocation(app, other.resident.id, other.incidentId, {
            location_source: 'unavailable',
          })
        ).statusCode,
      ).toBe(200);
    });
  });

  describe('races on separate connections', () => {
    const post = async (userId: string, incidentId: string, body: Body) => {
      const response = await fetch(`${baseUrl}/v1/incidents/${incidentId}/locations`, {
        method: 'POST',
        headers: { ...(await authHeader(userId)), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Body };
    };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** Holds the incident row lock on its own connection until `release`. */
    async function holdRow(incidentId: string) {
      const holder = await openTestClient();
      await holder.query('begin');
      await holder.query('select 1 from public.incidents where id = $1 for update', [incidentId]);
      return {
        release: async () => {
          await holder.query('commit');
          await holder.end();
        },
      };
    }

    /** Waits until `n` sessions wait on a lock (so the queued requests really are queued). */
    async function waitForLockWaiters(n: number) {
      for (let i = 0; i < 200; i++) {
        const waiting = await countRows(
          client,
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()`,
        );
        if (waiting >= n) return;
        await sleep(25);
      }
      throw new Error(`fewer than ${n} sessions waiting on a lock`);
    }

    it.each([
      ['newer first', ['2026-11-19T11:00:00.000002Z', '2026-11-19T11:00:00.000001Z']],
      ['older first', ['2026-11-19T11:00:00.000001Z', '2026-11-19T11:00:00.000002Z']],
    ])('two queued pings (%s): the older never wins', async (_order, times) => {
      const { resident, incidentId } = await incidentWithFix();
      const lock = await holdRow(incidentId);
      const first = post(
        resident.id,
        incidentId,
        fix(times[0], { location_lat: Number(times[0].slice(-3, -1)) }),
      );
      await waitForLockWaiters(1);
      const second = post(
        resident.id,
        incidentId,
        fix(times[1], { location_lat: Number(times[1].slice(-3, -1)) }),
      );
      await waitForLockWaiters(2);
      await lock.release();

      const replies = await Promise.all([first, second]);
      expect(replies.map((r) => r.status)).toEqual([200, 200]);
      expect(await storedLocation(incidentId)).toMatchObject({
        location_lat: 2,
        captured: '2026-11-19T11:00:00.000002',
      });
    });

    it(`${PARALLEL} parallel pings with shuffled fix times: the newest is stored`, async () => {
      const { resident, incidentId } = await incidentWithFix();
      const seconds = Array.from({ length: PARALLEL }, (_, i) => i + 1).sort(
        () => Math.random() - 0.5,
      );
      const replies = await Promise.all(
        seconds.map((s) =>
          post(
            resident.id,
            incidentId,
            fix(`2026-11-19T11:00:${String(s).padStart(2, '0')}Z`, { location_lat: s }),
          ),
        ),
      );
      expect(replies.every((r) => r.status === 200)).toBe(true);
      expect(await storedLocation(incidentId)).toMatchObject({
        location_lat: PARALLEL,
        captured: `2026-11-19T11:00:${String(PARALLEL).padStart(2, '0')}.000000`,
      });
    });

    it('two pings queued together, the newer queued second: the older never wins', async () => {
      const { resident, incidentId } = await incidentWithFix();
      const lock = await holdRow(incidentId);
      const older = post(
        resident.id,
        incidentId,
        fix('2026-11-19T11:00:00.000001Z', { location_lat: 1 }),
      );
      await waitForLockWaiters(1);
      const newer = post(
        resident.id,
        incidentId,
        fix('2026-11-19T11:00:00.000002Z', { location_lat: 2 }),
      );
      await waitForLockWaiters(2);
      await lock.release();
      await Promise.all([older, newer]);
      expect(await storedLocation(incidentId)).toMatchObject({ location_lat: 2 });
    });

    it('a ping queued behind mark safe: not_open after the close commits, never reopened', async () => {
      const { resident, incidentId } = await activeAlert();
      // Mark safe's close (IncidentStateService), held open on its own connection.
      const closer = await openTestClient();
      await closer.query('begin');
      await closer.query('select 1 from public.profiles where id = $1 for update', [resident.id]);
      await closer.query(
        `update public.incidents
            set status = 'resolved', resolved_at = now(), resolved_reason = 'safe',
                auto_closed = false, location_sharing_ended_at = now()
          where id = $1 and status = 'active'`,
        [incidentId],
      );

      const ping = post(resident.id, incidentId, fix('2026-11-19T11:00:00Z'));
      await waitForLockWaiters(1);
      await closer.query('commit');
      await closer.end();

      const reply = await ping;
      expect(reply.status).toBe(409);
      expect((reply.body as { error: { code: string } }).error.code).toBe(
        'attach_incident_location:not_open',
      );
      const { rows } = await client.query<Body>(
        'select status, location_lat, location_sharing_ended_at from public.incidents where id = $1',
        [incidentId],
      );
      expect(rows[0]).toMatchObject({ status: 'resolved', location_lat: null });
      expect(rows[0].location_sharing_ended_at).not.toBeNull();
    });

    it('pings racing mark safe: the incident ends resolved; a ping either landed before or got not_open', async () => {
      for (let round = 0; round < 5; round++) {
        const { resident, incidentId } = await activeAlert();
        const [replies, closed] = await Promise.all([
          Promise.all(
            Array.from({ length: 4 }, (_, i) =>
              post(resident.id, incidentId, fix(`2026-11-19T11:00:0${i}Z`, { location_lat: i })),
            ),
          ),
          fetch(`${baseUrl}/v1/incidents/${incidentId}/mark-safe`, {
            method: 'POST',
            headers: { ...(await authHeader(resident.id)), 'idempotency-key': randomUUID() },
          }),
        ]);
        for (const reply of replies) expect([200, 409]).toContain(reply.status);
        expect(closed.status).toBe(200);
        const { rows } = await client.query<Body>(
          'select status, location_sharing_ended_at from public.incidents where id = $1',
          [incidentId],
        );
        expect(rows[0].status).toBe('resolved');
        expect(rows[0].location_sharing_ended_at).not.toBeNull();
        const after = await post(resident.id, incidentId, fix('2099-01-01T00:00:00Z'));
        expect(after.status).toBe(409);
      }
    });
  });
});
