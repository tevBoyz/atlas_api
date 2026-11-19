import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp } from '../../src/testing/test-app';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  createCircle,
  createUser,
  inviteMember,
  type UserFixture,
} from '../support/fixtures';
import {
  attachLocation,
  markSafeViaSql,
  renotifyAlert,
  submitAlert,
} from '../support/incident-api';

/**
 * Parity coverage of db/baseline/tests/scrum45_closure_events.sql (API-100-13 AC5). One entry per SQL
 * assertion: the name quotes the SQL message, prefixed with its line in the file. `beforeAll` walks
 * the script's scenario in its order: submit (`POST /v1/incidents`), a live ping
 * (`POST /v1/incidents/{id}/locations`, API-100-17), mark safe, late pings and a re-notify after close
 * (`POST /v1/incidents/{id}/renotify`, API-100-18).
 *
 * Mark safe still goes through the SQL function `mark_incident_safe` as the resident, as the script
 * does; its endpoint is API-100-19, which also completes the remaining `it.todo` entries (mark safe
 * payload, events and retry, grants/RLS checks, member details via API-100-21, submit after close).
 * The member/outsider event visibility checks (L230-L282) are completed with the events read,
 * API-100-22.
 */
type Reply = Awaited<ReturnType<typeof attachLocation>>;
type Body = Record<string, unknown>;

describe('scrum45_closure_events.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let resident: UserFixture;
  let incidentId: string;

  let located: Reply;
  let lateFix: Reply;
  let lateUnavailable: Reply;
  let afterLatePings: Body;
  let renotifyAfterClose: Reply;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    resident = await createUser(client, { fullName: 'Resident Safe' });
    const member = await createUser(client, { fullName: 'Member Safe' });
    const member2 = await createUser(client, { fullName: 'Member Two' });
    const circle = await createCircle(client, resident);
    await addActiveMember(client, circle, member);
    await addActiveMember(client, circle, member2);
    await inviteMember(client, circle, { displayName: 'Pending Safe' });

    // Resident submits + live ping.
    incidentId = (await submitAlert(app, resident.id, 'burglary')).json<Body>().id as string;
    located = await attachLocation(app, resident.id, incidentId, {
      location_source: 'current',
      location_lat: 9.03,
      location_lng: 38.74,
      location_accuracy_m: 12.5,
      location_captured_at: new Date().toISOString(),
    });

    // Mark safe (SQL function until API-100-19), twice as in the script.
    await markSafeViaSql(client, resident.id, incidentId);
    await markSafeViaSql(client, resident.id, incidentId);

    // Late ping after close: rejected, no write, no reopen.
    lateFix = await attachLocation(app, resident.id, incidentId, {
      location_source: 'current',
      location_lat: 1.0,
      location_lng: 1.0,
      location_accuracy_m: 5.0,
      location_captured_at: new Date(Date.now() + 60_000).toISOString(),
    });
    lateUnavailable = await attachLocation(app, resident.id, incidentId, {
      location_source: 'unavailable',
    });
    const { rows } = await client.query<Body>(
      'select status, location_lat from public.incidents where id = $1',
      [incidentId],
    );
    afterLatePings = rows[0];

    renotifyAfterClose = await renotifyAlert(app, resident.id, incidentId);
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const codeOf = (reply: Reply) => reply.json<{ error: { code: string } }>().error.code;

  it.todo('L42: incident_events grants are not select-only for authenticated');
  it.todo('L46: incident_events RLS disabled');
  it.todo('L53: incident_events should have exactly one (select) policy: %');
  it.todo('L61: incidents_select_active_member lost _is_active_circle_member');

  it('L114: live attach failed: %', () => {
    expect(located.statusCode).toBe(200);
    expect(located.json<Body>().location_lat).toBe(9.03);
  });

  it.todo('L128: mark safe payload failed: %');
  it.todo('L148: events after mark safe wrong: %');
  it.todo('L158: closure_notified detail wrong: %');
  it.todo('L168: incident_closed detail wrong');
  it.todo('L176: mark safe retry changed the row: %');
  it.todo('L181: mark safe retry added events: %');

  it('L189: attach after close did not raise', () => {
    expect(lateFix.statusCode).toBe(409);
  });

  it('L193: attach after close got %', () => {
    expect(codeOf(lateFix)).toBe('attach_incident_location:not_open');
  });

  it('L199: unavailable attach after close did not raise', () => {
    expect(lateUnavailable.statusCode).toBe(409);
  });

  it('L203: unavailable attach after close got %', () => {
    expect(codeOf(lateUnavailable)).toBe('attach_incident_location:not_open');
  });

  it('L212: late ping reopened or rewrote the incident', () => {
    expect(afterLatePings).toEqual({ status: 'resolved', location_lat: 9.03 });
  });

  it('L217: renotify after close did not raise', () => {
    expect(renotifyAfterClose.statusCode).toBe(409);
  });

  it('L221: renotify after close got %', () => {
    expect(codeOf(renotifyAfterClose)).toBe('renotify_emergency_alert:not_open');
  });

  it.todo('L230: resident sees % events');
  it.todo('L239: active member sees % events');
  it.todo('L244: active member cannot see the closed incident');
  it.todo('L250: member inserted an event');
  it.todo('L257: member updated an incident');
  it.todo('L268: pending user sees % events');
  it.todo('L277: outsider sees % events');
  it.todo('L282: outsider sees the incident');
  it.todo('L292: resident updated an incident directly');
  it.todo('L299: resident inserted an incident directly');
  it.todo('L315: member details after close wrong: %');
  it.todo('L327: submit after close failed: %');
});
