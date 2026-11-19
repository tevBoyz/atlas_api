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
  countRows,
  markSafe,
  renotifyAlert,
  submitAlert,
} from '../support/incident-api';

/**
 * Parity coverage of db/baseline/tests/scrum45_closure_events.sql (API-100-13 AC5, API-100-19). One
 * entry per SQL assertion: the name quotes the SQL message, prefixed with its line in the file.
 * `beforeAll` walks the script's scenario in its order through the API: submit
 * (`POST /v1/incidents`), a live ping (`POST /v1/incidents/{id}/locations`), mark safe
 * (`POST /v1/incidents/{id}/mark-safe`) and its retry with a new Idempotency-Key, late pings and a
 * re-notify after close (`POST /v1/incidents/{id}/renotify`), then a new submit.
 *
 * The grant, RLS and direct-write checks (L42-L61, L250, L257, L292, L299) are about the database the
 * app still reads through Supabase until cutover: they run as the SQL does, against the database
 * roles, after the API has written the rows.
 *
 * Still `it.todo`, because they read through endpoints of later stories:
 * - event visibility per caller (L230, L239, L268, L277): `GET /v1/incidents/{id}/events`, API-100-22;
 * - a member or outsider reading the closed incident (L244, L282) and member details (L315):
 *   `GET /v1/responder/incidents` and `GET /v1/incidents/{id}`, API-100-21.
 */
type Reply = Awaited<ReturnType<typeof attachLocation>>;
type Body = Record<string, unknown>;

describe('scrum45_closure_events.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let resident: UserFixture;
  let member: UserFixture;
  let member2: UserFixture;
  let incidentId: string;

  let located: Reply;
  let safe1Reply: Reply;
  let safe1: Body;
  let safe2Reply: Reply;
  let safe2: Body;
  let eventsAfterSafe: Body;
  let eventsAfterRetry: number;
  let lateFix: Reply;
  let lateUnavailable: Reply;
  let afterLatePings: Body;
  let renotifyAfterClose: Reply;
  let newSubmit: Reply;

  const eventCounts = async (id: string) => {
    const { rows } = await client.query<{ counts: Body | null }>(
      `select jsonb_object_agg(e.event_type, e.cnt) as counts
         from (select event_type, count(*)::int as cnt
                 from public.incident_events
                where incident_id = $1
                group by event_type) e`,
      [id],
    );
    return rows[0].counts ?? {};
  };

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    resident = await createUser(client, { fullName: 'Resident Safe' });
    member = await createUser(client, { fullName: 'Member Safe' });
    member2 = await createUser(client, { fullName: 'Member Two' });
    await createUser(client, { fullName: 'Pending Safe' });
    await createUser(client, { fullName: 'Outsider Safe' });
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

    // Mark safe.
    safe1Reply = await markSafe(app, resident.id, incidentId);
    safe1 = safe1Reply.json<Body>();
    eventsAfterSafe = await eventCounts(incidentId);

    // Idempotent retry with a new Idempotency-Key: the domain no-op, not a stored replay.
    safe2Reply = await markSafe(app, resident.id, incidentId);
    safe2 = safe2Reply.json<Body>();
    eventsAfterRetry = await countRows(
      client,
      'select count(*)::int as n from public.incident_events where incident_id = $1',
      [incidentId],
    );

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

    // A new submit after close is a new incident.
    newSubmit = await submitAlert(app, resident.id, 'medical');
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const codeOf = (reply: Reply) => reply.json<{ error: { code: string } }>().error.code;

  /**
   * Runs `statement` as the `authenticated` role with `userId`'s JWT claims, as the script's
   * `set local role authenticated` block does, and returns the SQLSTATE it failed with (null when it
   * succeeded). Always rolled back.
   */
  const sqlStateAs = async (userId: string, statement: string, params: unknown[]) => {
    await client.query('begin');
    try {
      await client.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
      );
      await client.query('set local role authenticated');
      await client.query(statement, params);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    } finally {
      await client.query('rollback');
    }
  };

  it('L42: incident_events grants are not select-only for authenticated', async () => {
    const { rows } = await client.query(
      `select has_table_privilege('authenticated', 'public.incident_events', 'insert') as can_insert,
              has_table_privilege('authenticated', 'public.incident_events', 'update') as can_update,
              has_table_privilege('authenticated', 'public.incident_events', 'delete') as can_delete,
              has_table_privilege('authenticated', 'public.incident_events', 'select') as can_select,
              has_table_privilege('anon', 'public.incident_events', 'select') as anon_select`,
    );
    expect(rows[0]).toEqual({
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_select: true,
      anon_select: false,
    });
  });

  it('L46: incident_events RLS disabled', async () => {
    const { rows } = await client.query<{ rls: boolean }>(
      `select c.relrowsecurity as rls from pg_class c
        where c.oid = 'public.incident_events'::regclass`,
    );
    expect(rows[0].rls).toBe(true);
  });

  it('L53: incident_events should have exactly one (select) policy: %', async () => {
    const { rows } = await client.query<{ cmd: string }>(
      `select cmd from pg_policies where schemaname = 'public' and tablename = 'incident_events'`,
    );
    expect(rows).toEqual([{ cmd: 'SELECT' }]);
  });

  it('L61: incidents_select_active_member lost _is_active_circle_member', async () => {
    const { rows } = await client.query<{ qual: string }>(
      `select pg_get_expr(p.polqual, p.polrelid) as qual
         from pg_policy p
        where p.polrelid = 'public.incidents'::regclass
          and p.polname = 'incidents_select_active_member'`,
    );
    expect(rows[0].qual).toMatch(/_is_active_circle_member/i);
  });

  it('L114: live attach failed: %', () => {
    expect(located.statusCode).toBe(200);
    expect(located.json<Body>().location_lat).toBe(9.03);
  });

  it('L128: mark safe payload failed: %', () => {
    expect(safe1Reply.statusCode).toBe(200);
    expect(safe1).toMatchObject({
      status: 'resolved',
      resolved_reason: 'safe',
      auto_closed: false,
      delivered_count: 2,
      emergency_type: 'burglary',
    });
    expect(safe1.resolved_at).toEqual(expect.any(String));
    expect(safe1.location_sharing_ended_at).toEqual(expect.any(String));
  });

  it('L148: events after mark safe wrong: %', () => {
    expect(eventsAfterSafe).toEqual({
      alert_sent: 1,
      location_sharing_started: 1,
      safe_recorded: 1,
      incident_closed: 1,
      location_sharing_ended: 1,
      closure_notified: 1,
    });
  });

  it('L158: closure_notified detail wrong: %', async () => {
    const { rows } = await client.query<{
      detail: { recipient_count: number; recipient_ids: string[] };
    }>(
      `select detail from public.incident_events
        where incident_id = $1 and event_type = 'closure_notified'`,
      [incidentId],
    );
    expect(rows).toHaveLength(1);
    const { detail } = rows[0];
    expect(detail.recipient_count).toBe(2);
    expect(detail.recipient_ids).toHaveLength(2);
    expect(detail.recipient_ids).not.toContain(resident.id);
    expect(new Set(detail.recipient_ids)).toEqual(new Set([member.id, member2.id]));
  });

  it('L168: incident_closed detail wrong', async () => {
    expect(
      await countRows(
        client,
        `select count(*)::int as n from public.incident_events e
          where e.incident_id = $1
            and e.event_type = 'incident_closed'
            and e.detail->>'resolved_reason' = 'safe'
            and e.actor_id = $2`,
        [incidentId, resident.id],
      ),
    ).toBe(1);
  });

  it('L176: mark safe retry changed the row: %', () => {
    expect(safe2Reply.statusCode).toBe(200);
    expect(safe2Reply.headers['idempotent-replayed']).toBeUndefined();
    expect(safe2.resolved_at).toBe(safe1.resolved_at);
    expect(safe2.location_sharing_ended_at).toBe(safe1.location_sharing_ended_at);
    expect(safe2.status).toBe('resolved');
  });

  it('L181: mark safe retry added events: %', () => {
    expect(eventsAfterRetry).toBe(6);
  });

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

  it('L250: member inserted an event', async () => {
    expect(
      await sqlStateAs(
        member.id,
        `insert into public.incident_events (incident_id, event_type, actor_id)
         values ($1, 'renotified', $2)`,
        [incidentId, member.id],
      ),
    ).toBe('42501');
  });

  it('L257: member updated an incident', async () => {
    expect(
      await sqlStateAs(member.id, `update public.incidents set status = 'active' where id = $1`, [
        incidentId,
      ]),
    ).toBe('42501');
  });

  it.todo('L268: pending user sees % events');
  it.todo('L277: outsider sees % events');
  it.todo('L282: outsider sees the incident');

  it('L292: resident updated an incident directly', async () => {
    expect(
      await sqlStateAs(resident.id, `update public.incidents set status = 'active' where id = $1`, [
        incidentId,
      ]),
    ).toBe('42501');
  });

  it('L299: resident inserted an incident directly', async () => {
    expect(
      await sqlStateAs(
        resident.id,
        `insert into public.incidents (resident_id, status) values ($1, 'activating')`,
        [resident.id],
      ),
    ).toBe('42501');
  });

  it.todo('L315: member details after close wrong: %');

  it('L327: submit after close failed: %', () => {
    expect(newSubmit.statusCode).toBe(201);
    const inc = newSubmit.json<Body>();
    expect(inc.id).not.toBe(incidentId);
    expect(inc.submit_outcome).toBe('created');
    expect(inc.status).toBe('active');
  });
});
