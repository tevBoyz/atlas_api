import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { httpStatusForCode, PARITY_ERROR_CODES } from '../../src/common/errors';
import { createTestApp } from '../../src/testing/test-app';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
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
  markSafe,
  renotifyAlert,
  setIncidentNotes,
  submitAlert,
} from '../support/incident-api';
import { specIncidentErrorCodes } from '../support/spec-error-codes';

/**
 * API-100-23 AC2: every incident error code of the specification is produced by at least one real
 * response. The codes are read from `docs/api_doc.md` (§7.4 and §11.3 E11), not typed here; each one
 * must have a producer below, and each producer sends one request and checks the envelope's `code`
 * and the HTTP status of spec §11.2. The last test checks that every code was seen in a response.
 *
 * `mark_incident_safe:not_open` needs a legacy row (`cancelled`, `activating`, or `resolved` with
 * `ended`): the API cannot create one, so it is inserted directly, as old app versions left them.
 */
type Reply = Awaited<ReturnType<typeof submitAlert>>;

/** The prefixes of spec §7.4 plus the events read (§11.3 E11). */
const INCIDENT_PREFIXES = [
  'submit_emergency_alert',
  'get_my_open_incident',
  'list_my_recent_incidents',
  'get_live_location_config',
  'attach_incident_location',
  'set_incident_notes',
  'renotify_emergency_alert',
  'mark_incident_safe',
  'incident_delivery_counts',
  'acknowledge_incident',
  'list_responder_incidents',
  'get_incident_details',
  'incident_events',
] as const;

describe('Phase 1 gate: every incident error code of the spec is produced (API-100-23 AC2)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  let resident: UserFixture;
  let member: UserFixture;
  let pending: UserFixture;
  let outsider: UserFixture;
  let circle: CircleFixture;
  /** Active incident of `resident`, `member` has a delivery row. */
  let openId: string;
  /** Resolved (safe) incident of a second resident, `closedMember` has a delivery row. */
  let closedId: string;
  let closedResident: UserFixture;
  let closedMember: UserFixture;
  let legacyCancelled: { resident: UserFixture; id: string };
  const unknownId = randomUUID();

  const produced = new Map<string, number>();

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    resident = await createUser(client, { fullName: 'Codes Resident' });
    member = await createUser(client, { fullName: 'Codes Member' });
    pending = await createUser(client, { fullName: 'Codes Pending' });
    outsider = await createUser(client, { fullName: 'Codes Outsider' });
    circle = await createCircle(client, resident);
    await addActiveMember(client, circle, member);
    await inviteMember(client, circle, { claimedBy: pending });
    openId = (await submitAlert(app, resident.id, 'medical')).json<{ id: string }>().id;

    closedResident = await createUser(client, { fullName: 'Codes Closed Resident' });
    closedMember = await createUser(client, { fullName: 'Codes Closed Member' });
    const closedCircle = await createCircle(client, closedResident);
    await addActiveMember(client, closedCircle, closedMember);
    closedId = (await submitAlert(app, closedResident.id, 'fire')).json<{ id: string }>().id;
    expect((await markSafe(app, closedResident.id, closedId)).statusCode).toBe(200);

    const legacyResident = await createUser(client, { fullName: 'Codes Legacy Resident' });
    const { rows } = await client.query<{ id: string }>(
      `insert into public.incidents (resident_id, status, emergency_type, cancelled_at)
       values ($1, 'cancelled', 'unspecified', now()) returning id`,
      [legacyResident.id],
    );
    legacyCancelled = { resident: legacyResident, id: rows[0].id };
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  /** A request with no Authorization header (`not_authenticated` for every route). */
  const anonymous = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        'idempotency-key': randomUUID(),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });

  const noProfileUser = () => createUser(client, { profile: false });

  const PRODUCERS: Record<string, () => Promise<Reply>> = {
    // submit_emergency_alert
    'submit_emergency_alert:not_authenticated': () =>
      anonymous('POST', '/v1/incidents', { emergency_type: 'medical' }),
    'submit_emergency_alert:invalid_type': () => submitAlert(app, resident.id, 'crime_safety'),
    'submit_emergency_alert:profile_not_found': async () =>
      submitAlert(app, (await noProfileUser()).id, 'medical'),
    'submit_emergency_alert:profile_setup_incomplete': async () => {
      const user = await createUser(client);
      await client.query(
        'update public.profiles set profile_setup_completed_at = null where id = $1',
        [user.id],
      );
      return submitAlert(app, user.id, 'medical');
    },
    // reads without a token
    'get_my_open_incident:not_authenticated': () => anonymous('GET', '/v1/me/incidents/open'),
    'list_my_recent_incidents:not_authenticated': () => anonymous('GET', '/v1/me/incidents'),
    'get_live_location_config:not_authenticated': () =>
      anonymous('GET', '/v1/config/live-location'),
    'list_responder_incidents:not_authenticated': () => anonymous('GET', '/v1/responder/incidents'),
    // attach_incident_location
    'attach_incident_location:not_authenticated': () =>
      anonymous('POST', `/v1/incidents/${openId}/locations`, { location_source: 'unavailable' }),
    'attach_incident_location:invalid_source': () =>
      attachLocation(app, resident.id, openId, { location_source: 'gps' }),
    'attach_incident_location:invalid_location': () =>
      attachLocation(app, resident.id, openId, {
        location_source: 'current',
        location_lat: 91,
        location_lng: 0,
        location_accuracy_m: 5,
        location_captured_at: new Date().toISOString(),
      }),
    'attach_incident_location:not_found': () =>
      attachLocation(app, member.id, openId, { location_source: 'unavailable' }),
    'attach_incident_location:not_open': () =>
      attachLocation(app, closedResident.id, closedId, { location_source: 'unavailable' }),
    // set_incident_notes
    'set_incident_notes:not_authenticated': () =>
      anonymous('PUT', `/v1/incidents/${openId}/notes`, { incident_notes: 'x' }),
    'set_incident_notes:not_found': () =>
      setIncidentNotes(app, member.id, openId, { incident_notes: 'x' }),
    'set_incident_notes:not_open': () =>
      setIncidentNotes(app, closedResident.id, closedId, { incident_notes: 'x' }),
    'set_incident_notes:too_long': () =>
      setIncidentNotes(app, resident.id, openId, { incident_notes: 'n'.repeat(251) }),
    // renotify_emergency_alert
    'renotify_emergency_alert:not_authenticated': () =>
      anonymous('POST', `/v1/incidents/${openId}/renotify`),
    'renotify_emergency_alert:not_found': () => renotifyAlert(app, outsider.id, openId),
    'renotify_emergency_alert:not_open': () => renotifyAlert(app, closedResident.id, closedId),
    // mark_incident_safe
    'mark_incident_safe:not_authenticated': () =>
      anonymous('POST', `/v1/incidents/${openId}/mark-safe`),
    'mark_incident_safe:not_found': () => markSafe(app, member.id, openId),
    'mark_incident_safe:not_open': () =>
      markSafe(app, legacyCancelled.resident.id, legacyCancelled.id),
    // incident_delivery_counts
    'incident_delivery_counts:not_authenticated': () =>
      anonymous('GET', `/v1/incidents/${openId}/delivery-counts`),
    'incident_delivery_counts:not_found': () => getDeliveryCounts(app, outsider.id, openId),
    // acknowledge_incident
    'acknowledge_incident:not_authenticated': () =>
      anonymous('POST', `/v1/incidents/${openId}/acknowledge`),
    'acknowledge_incident:not_found': () => acknowledgeIncident(app, pending.id, openId),
    'acknowledge_incident:not_open': () => acknowledgeIncident(app, closedMember.id, closedId),
    // get_incident_details
    'get_incident_details:not_authenticated': () => anonymous('GET', `/v1/incidents/${openId}`),
    'get_incident_details:not_found': () => getIncidentDetails(app, resident.id, openId),
    // incident_events (§11.3 E11)
    'incident_events:not_authenticated': () => anonymous('GET', `/v1/incidents/${openId}/events`),
    'incident_events:not_found': () => getIncidentEvents(app, outsider.id, unknownId),
  };

  const specCodes = specIncidentErrorCodes();
  const catalogueCodes = INCIDENT_PREFIXES.flatMap((prefix) =>
    PARITY_ERROR_CODES[prefix].map((suffix) => `${prefix}:${suffix}`),
  );

  it('reads the incident codes of spec §7.4 and §11.3 E11 (12 RPCs + the events read)', () => {
    expect(new Set(specCodes.map((code) => code.split(':')[0]))).toEqual(
      new Set(INCIDENT_PREFIXES),
    );
    expect(specCodes.length).toBeGreaterThanOrEqual(30);
  });

  it('the spec codes are exactly the parity catalogue for these prefixes', () => {
    // incident_events:not_authenticated is the guard's code for E11 (catalogue, not in the spec row).
    expect([...specCodes, 'incident_events:not_authenticated'].sort()).toEqual(
      [...catalogueCodes].sort(),
    );
  });

  it('has a producer for every spec and catalogue code', () => {
    const wanted = new Set([...specCodes, ...catalogueCodes]);
    expect([...wanted].filter((code) => !(code in PRODUCERS))).toEqual([]);
    expect(Object.keys(PRODUCERS).filter((code) => !wanted.has(code))).toEqual([]);
  });

  it.each(Object.keys(PRODUCERS))('%s is produced', async (code) => {
    const reply = await PRODUCERS[code]();
    const body = reply.json<{ error: { code: string } }>();
    expect(body.error.code).toBe(code);
    expect(reply.statusCode).toBe(httpStatusForCode(code));
    produced.set(code, reply.statusCode);
  });

  it('every spec code was seen in a response', () => {
    expect(specCodes.filter((code) => !produced.has(code))).toEqual([]);
    expect(catalogueCodes.filter((code) => !produced.has(code))).toEqual([]);
  });
});
