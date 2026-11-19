import { randomUUID } from 'node:crypto';

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
  acknowledgeIncident,
  countRows,
  renotifyAlert,
  submitAlert,
} from '../support/incident-api';

/**
 * Parity coverage of db/baseline/tests/scrum43_submit_emergency_alert.sql (API-100-13 AC5, API-100-15).
 * One entry per SQL assertion: the name quotes the SQL message, prefixed with its line in the file.
 * `beforeAll` walks the same scenario as the SQL script, in the same order, through
 * `POST /v1/incidents`; each test then checks what that assertion checks.
 *
 * Every assertion is covered. L309 uses `POST /v1/incidents/{id}/renotify` (API-100-18) and L318
 * `POST /v1/incidents/{id}/acknowledge` (API-100-20).
 */
type Reply = Awaited<ReturnType<typeof submitAlert>>;
type Body = Record<string, unknown>;

const INVALID_TYPES = ['unspecified', 'crime_safety', 'accident', 'Medical', '', 'police'];

describe('scrum43_submit_emergency_alert.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let resident: UserFixture;
  let member: UserFixture;
  let noProfile: UserFixture;
  let incomplete: UserFixture;
  let circleId: string;

  let anonymous: Reply;
  let noProfileReply: Reply;
  let incompleteReply: Reply;
  const invalidReplies = new Map<string, Reply>();
  let nullTypeReply: Reply;
  let rowsAfterInvalid: number;
  let firstReply: Reply;
  let secondReply: Reply;
  let thirdReply: Reply;
  let first: Body;
  let second: Body;
  let third: Body;
  let memberOwnReply: Reply;
  let memberOwn: Body;

  const eventDetail = async (incidentId: unknown, eventType: string) => {
    const { rows } = await client.query<{ detail: Body; actor_id: string }>(
      `select detail, actor_id from public.incident_events
        where incident_id = $1 and event_type = $2`,
      [incidentId, eventType],
    );
    return rows;
  };

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    resident = await createUser(client, { fullName: 'Resident Submit' });
    member = await createUser(client, { fullName: 'Member Submit' });
    noProfile = await createUser(client, { profile: false });
    incomplete = await createUser(client, { fullName: 'Incomplete Submit' });
    await client.query(
      `update public.profiles set profile_setup_completed_at = null where id = $1`,
      [incomplete.id],
    );
    await client.query(
      `update public.profiles
          set blood_type = 'O+', share_blood_type = true,
              allergies = 'Peanuts', share_allergies = false
        where id = $1`,
      [resident.id],
    );
    const circle = await createCircle(client, resident);
    circleId = circle.id;
    await addActiveMember(client, circle, member);
    await inviteMember(client, circle, { displayName: 'Pending Submit' });

    anonymous = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      payload: JSON.stringify({ emergency_type: 'medical' }),
    });
    noProfileReply = await submitAlert(app, noProfile.id, 'medical');
    incompleteReply = await submitAlert(app, incomplete.id, 'fire');

    for (const type of INVALID_TYPES) {
      invalidReplies.set(type, await submitAlert(app, resident.id, type));
    }
    nullTypeReply = await submitAlert(app, resident.id, null);
    rowsAfterInvalid = await countRows(
      client,
      `select count(*)::int as n from public.incidents where resident_id = $1`,
      [resident.id],
    );

    firstReply = await submitAlert(app, resident.id, 'domestic_violence');
    first = firstReply.json<Body>();
    secondReply = await submitAlert(app, resident.id, 'fire');
    second = secondReply.json<Body>();
    thirdReply = await submitAlert(app, resident.id, 'medical');
    third = thirdReply.json<Body>();

    memberOwnReply = await submitAlert(app, member.id, 'other');
    memberOwn = memberOwnReply.json<Body>();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const expectError = (reply: Reply, status: number, code: string) => {
    expect(reply.statusCode).toBe(status);
    expect(reply.json<{ error: { code: string } }>().error.code).toBe(code);
  };

  it('L44: a retired RPC still exists', async () => {
    const { rows } = await client.query<{ retired: string | null }>(
      `select unnest(array[
         to_regprocedure('public.start_emergency_activation()')::text,
         to_regprocedure('public.set_emergency_type(uuid,text)')::text,
         to_regprocedure('public.send_emergency_alert(uuid)')::text,
         to_regprocedure('public.cancel_emergency_activation(uuid)')::text,
         to_regprocedure('public.end_incident(uuid)')::text,
         to_regprocedure('public.incident_inactivity_due()')::text,
         to_regprocedure('public.confirm_incident_still_active(uuid)')::text,
         to_regprocedure('public.auto_close_inactive_incident(uuid)')::text,
         to_regprocedure('public._incident_activity_at(public.incidents)')::text,
         to_regprocedure('public._incident_inactivity_is_due(public.incidents)')::text
       ]) as retired`,
    );
    expect(rows.filter((row) => row.retired !== null)).toEqual([]);
  });

  it('L50: submit_emergency_alert grants wrong', async () => {
    const { rows } = await client.query<{ anon: boolean; authenticated: boolean }>(
      `select has_function_privilege('anon', 'public.submit_emergency_alert(text)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.submit_emergency_alert(text)', 'execute')
                as authenticated`,
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: true });
  });

  it('L58: incidents client grants are not select-only', async () => {
    const { rows } = await client.query(
      `select has_table_privilege('authenticated', 'public.incidents', 'insert') as can_insert,
              has_table_privilege('authenticated', 'public.incidents', 'update') as can_update,
              has_table_privilege('authenticated', 'public.incidents', 'delete') as can_delete,
              has_table_privilege('authenticated', 'public.incidents', 'select') as can_select`,
    );
    expect(rows[0]).toEqual({
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_select: true,
    });
  });

  it('L62: one-open unique index missing', async () => {
    const { rows } = await client.query<{ index: string | null }>(
      `select to_regclass('public.incidents_one_open_per_resident_uidx')::text as index`,
    );
    expect(rows[0].index).not.toBeNull();
  });

  it('L70: legacy type rows remain: %', async () => {
    const legacy = await countRows(
      client,
      `select count(*)::int as n from public.incidents
        where emergency_type in ('crime_safety', 'accident')`,
    );
    expect(legacy).toBe(0);
  });

  it('L77: activating rows remain: %', async () => {
    const activating = await countRows(
      client,
      `select count(*)::int as n from public.incidents where status = 'activating'`,
    );
    expect(activating).toBe(0);
  });

  it('L124: constraint accepted %', async () => {
    for (const bad of ['crime_safety', 'accident', 'police']) {
      await expect(
        client.query(
          `insert into public.incidents (resident_id, status, emergency_type, cancelled_at)
           values ($1, 'cancelled', $2, now())`,
          [resident.id, bad],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('L135: anonymous submit did not raise', () => {
    expect(anonymous.statusCode).toBe(401);
  });

  it('L139: anonymous submit got %', () => {
    expectError(anonymous, 401, 'submit_emergency_alert:not_authenticated');
  });

  it('L149: no-profile submit did not raise', () => {
    expect(noProfileReply.statusCode).toBe(404);
  });

  it('L153: no-profile submit got %', () => {
    expectError(noProfileReply, 404, 'submit_emergency_alert:profile_not_found');
  });

  it('L162: incomplete submit did not raise', () => {
    expect(incompleteReply.statusCode).toBe(409);
  });

  it('L166: incomplete submit got %', () => {
    expectError(incompleteReply, 409, 'submit_emergency_alert:profile_setup_incomplete');
  });

  it('L179: type % accepted', () => {
    for (const type of INVALID_TYPES) {
      expect(invalidReplies.get(type)?.statusCode).toBe(422);
    }
  });

  it('L183: type % got %', () => {
    for (const type of INVALID_TYPES) {
      expectError(invalidReplies.get(type) as Reply, 422, 'submit_emergency_alert:invalid_type');
    }
  });

  it('L190: null type accepted', () => {
    expect(nullTypeReply.statusCode).toBe(422);
  });

  it('L194: null type got %', () => {
    expectError(nullTypeReply, 422, 'submit_emergency_alert:invalid_type');
  });

  it('L200: invalid submit created a row', () => {
    expect(rowsAfterInvalid).toBe(0);
  });

  it('L220: create payload failed: %', () => {
    expect(firstReply.statusCode).toBe(201);
    expect(first).toMatchObject({
      status: 'active',
      emergency_type: 'domestic_violence',
      submit_outcome: 'created',
      resident_id: resident.id,
      circle_id: circleId,
      delivered_count: 1,
      acknowledged_count: 0,
      renotified_at: null,
      location_sharing_ended_at: null,
      resolved_at: null,
      share_payload: { blood_type: 'O+' },
    });
    expect(first.share_payload).toEqual({ blood_type: 'O+' });
    expect(first.sent_at).toEqual(expect.any(String));
    expect(first.activated_at).toEqual(expect.any(String));
    for (const key of ['location_lat', 'incident_notes', 'cancelled_at']) {
      expect(first).toHaveProperty(key);
    }
  });

  it('L231: deliveries wrong (pending / resident / missing): %', async () => {
    const { rows } = await client.query<{ member_user_id: string }>(
      `select member_user_id from public.incident_deliveries where incident_id = $1`,
      [first.id],
    );
    expect(rows).toEqual([{ member_user_id: member.id }]);
  });

  it('L241: alert_sent detail wrong: %', async () => {
    const events = await eventDetail(first.id, 'alert_sent');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({
      recipient_count: 1,
      recipient_ids: [member.id],
      emergency_type: 'domestic_violence',
    });
  });

  it('L250: location_sharing_started missing', async () => {
    const events = await eventDetail(first.id, 'location_sharing_started');
    expect(events).toEqual([{ detail: {}, actor_id: resident.id }]);
  });

  it('L264: second submit failed: %', () => {
    expect(secondReply.statusCode).toBe(200);
    expect(second).toMatchObject({
      id: first.id,
      submit_outcome: 'renotified',
      emergency_type: 'domestic_violence',
      status: 'active',
      sent_at: first.sent_at,
      delivered_count: 1,
    });
    expect(second.renotified_at).not.toBeNull();
  });

  it('L271: third submit failed: %', () => {
    expect(thirdReply.statusCode).toBe(200);
    expect(third).toMatchObject({ id: first.id, emergency_type: 'domestic_violence' });
  });

  it('L278: double submit created % incidents', async () => {
    const incidents = await countRows(
      client,
      `select count(*)::int as n from public.incidents where resident_id = $1`,
      [resident.id],
    );
    expect(incidents).toBe(1);
  });

  it('L285: double submit duplicated deliveries: %', async () => {
    const deliveries = await countRows(
      client,
      `select count(*)::int as n from public.incident_deliveries where incident_id = $1`,
      [first.id],
    );
    expect(deliveries).toBe(1);
  });

  it('L293: double submit duplicated lifecycle events: %', async () => {
    const lifecycle = await countRows(
      client,
      `select count(*)::int as n from public.incident_events
        where incident_id = $1 and event_type in ('alert_sent', 'location_sharing_started')`,
      [first.id],
    );
    expect(lifecycle).toBe(2);
  });

  it('L302: renotified events wrong: %', async () => {
    const renotified = await countRows(
      client,
      `select count(*)::int as n from public.incident_events
        where incident_id = $1 and event_type = 'renotified'
          and (detail->>'recipient_count')::int = 1`,
      [first.id],
    );
    expect(renotified).toBe(2);
  });

  // Runs here, not in beforeAll: the script calls it after counting the renotified events (L302).
  it('L309: renotify_emergency_alert failed: %', async () => {
    const reply = await renotifyAlert(app, resident.id, first.id as string);
    expect(reply.statusCode).toBe(200);
    const body = reply.json<Body>();
    expect(body.id).toBe(first.id);
    expect(Date.parse(body.renotified_at as string)).toBeGreaterThanOrEqual(
      Date.parse(second.renotified_at as string),
    );
    expect(body).not.toHaveProperty('submit_outcome');
  });

  // Runs here, after L309, as in the script: the member acknowledges through
  // POST /v1/incidents/{id}/acknowledge (API-100-20) and the counts reflect it.
  it('L318: ack failed: %', async () => {
    const reply = await acknowledgeIncident(app, member.id, first.id as string);
    expect(reply.statusCode).toBe(200);
    expect(reply.json<Body>().acknowledged_count).toBe(1);
  });

  it('L328: member own submit failed: %', () => {
    expect(memberOwnReply.statusCode).toBe(201);
    expect(memberOwn.resident_id).toBe(member.id);
    expect(memberOwn.id).not.toBe(first.id);
    expect(memberOwn.circle_id).toBeNull();
    expect(memberOwn.delivered_count).toBe(0);
  });

  it('L336: zero-recipient alert_sent wrong: %', async () => {
    const events = await eventDetail(memberOwn.id, 'alert_sent');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ recipient_count: 0, recipient_ids: [] });
  });
});
