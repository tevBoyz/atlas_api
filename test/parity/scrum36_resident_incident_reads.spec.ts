import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp } from '../../src/testing/test-app';
import { openTestClient } from '../support/database';
import { createUser, type UserFixture } from '../support/fixtures';
import {
  countRows,
  getOpenIncident,
  listRecentIncidents,
  markSafeViaSql,
  submitAlert,
} from '../support/incident-api';

/**
 * Parity coverage of db/baseline/tests/scrum36_resident_incident_reads.sql (API-100-13 AC5,
 * API-100-16). One entry per SQL assertion: the name quotes the SQL message, prefixed with its line in
 * the file. `beforeAll` walks the same scenario as the SQL script, in the same order, through
 * `GET /v1/me/incidents/open`, `GET /v1/me/incidents` and `POST /v1/incidents`; each test then checks
 * what that assertion checks.
 *
 * Differences from the script, none of which changes what is asserted:
 * - Mark safe goes through the SQL function `mark_incident_safe` as the resident (its endpoint is
 *   API-100-19), exactly as the script does. API-100-19 switches these calls to the endpoint.
 * - The script backdates `activated_at` with a direct UPDATE; so does this suite.
 * - "null limit" (`list_my_recent_incidents(null)`) is a request without `limit`: a query string
 *   cannot carry JSON null.
 * - The open read is wrapped (`{"open_incident": ...}`, epic §18 D2); assertions read inside it.
 */
type Reply = Awaited<ReturnType<typeof getOpenIncident>>;
type Body = Record<string, unknown>;
type Recent = Body[];

const TYPES = ['medical', 'domestic_violence', 'fire', 'burglary', 'other'];

describe('scrum36_resident_incident_reads.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let resident: UserFixture;
  let other: UserFixture;

  let anonymousOpen: Reply;
  let anonymousRecent: Reply;
  let otherId: string;
  let openBefore: Reply;
  let recentBefore: Reply;
  const ids: string[] = [];
  let inc: Body;
  let openAfterSubmit: Reply;
  let defaultList: Reply;
  let list20: Reply;
  let list500: Reply;
  let list0: Reply;
  let listMinus3: Reply;
  let listNull: Reply;
  let openAfterSafe: Reply;
  let list1AfterSafe: Reply;

  const openOf = (reply: Reply) => reply.json<{ open_incident: Body | null }>().open_incident;
  const recentOf = (reply: Reply) => reply.json<Recent>();

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    resident = await createUser(client, { fullName: 'Resident Reads' });
    other = await createUser(client, { fullName: 'Other Reads' });

    // Legacy cancelled row: never listed.
    await client.query(
      `insert into public.incidents (resident_id, status, emergency_type, activated_at, cancelled_at)
       values ($1, 'cancelled', 'unspecified', now() + interval '1 hour', now())`,
      [resident.id],
    );

    // No JWT.
    anonymousOpen = await app.inject({ method: 'GET', url: '/v1/me/incidents/open' });
    anonymousRecent = await app.inject({ method: 'GET', url: '/v1/me/incidents' });

    // Other user has an open incident.
    otherId = (await submitAlert(app, other.id, 'fire')).json<Body>().id as string;

    // Resident.
    openBefore = await getOpenIncident(app, resident.id);
    recentBefore = await listRecentIncidents(app, resident.id);

    // Seven closed incidents, then one open.
    for (let i = 1; i <= 7; i++) {
      const closed = (await submitAlert(app, resident.id, TYPES[i % 5])).json<Body>();
      ids.push(closed.id as string);
      await markSafeViaSql(client, resident.id, closed.id);
      // Distinct, increasing activated_at for deterministic order.
      await client.query(
        `update public.incidents
            set activated_at = now() - interval '1 day' + make_interval(mins => $2)
          where id = $1`,
        [closed.id, i],
      );
    }

    inc = (await submitAlert(app, resident.id, 'medical')).json<Body>();
    ids.push(inc.id as string);

    openAfterSubmit = await getOpenIncident(app, resident.id);
    defaultList = await listRecentIncidents(app, resident.id);
    list20 = await listRecentIncidents(app, resident.id, 'limit=20');
    list500 = await listRecentIncidents(app, resident.id, 'limit=500');
    list0 = await listRecentIncidents(app, resident.id, 'limit=0');
    listMinus3 = await listRecentIncidents(app, resident.id, 'limit=-3');
    listNull = await listRecentIncidents(app, resident.id);

    // After mark safe, no open incident; completed one tops Recent Activity.
    await markSafeViaSql(client, resident.id, inc.id);
    openAfterSafe = await getOpenIncident(app, resident.id);
    list1AfterSafe = await listRecentIncidents(app, resident.id, 'limit=1');
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const expectError = (reply: Reply, status: number, code: string) => {
    expect(reply.statusCode).toBe(status);
    expect(reply.json<{ error: { code: string } }>().error.code).toBe(code);
  };

  it('L29: read RPC grants wrong', async () => {
    const { rows } = await client.query(
      `select has_function_privilege('anon', 'public.get_my_open_incident()', 'execute') as anon_open,
              has_function_privilege('anon', 'public.list_my_recent_incidents(integer)', 'execute')
                as anon_recent,
              has_function_privilege('authenticated', 'public.get_my_open_incident()', 'execute')
                as auth_open,
              has_function_privilege('authenticated', 'public.list_my_recent_incidents(integer)',
                                     'execute') as auth_recent`,
    );
    expect(rows[0]).toEqual({
      anon_open: false,
      anon_recent: false,
      auth_open: true,
      auth_recent: true,
    });
  });

  it('L51: anonymous open read did not raise', () => {
    expect(anonymousOpen.statusCode).toBe(401);
  });

  it('L55: anonymous open read got %', () => {
    expectError(anonymousOpen, 401, 'get_my_open_incident:not_authenticated');
  });

  it('L60: anonymous recent read did not raise', () => {
    expect(anonymousRecent.statusCode).toBe(401);
  });

  it('L64: anonymous recent read got %', () => {
    expectError(anonymousRecent, 401, 'list_my_recent_incidents:not_authenticated');
  });

  it('L81: open read before submit should be null: %', () => {
    expect(openBefore.statusCode).toBe(200);
    expect(openBefore.json()).toEqual({ open_incident: null });
  });

  it('L86: recent list should be empty (cancelled excluded): %', () => {
    expect(recentBefore.statusCode).toBe(200);
    expect(recentBefore.json()).toEqual([]);
  });

  it('L114: open read failed: %', () => {
    expect(openAfterSubmit.statusCode).toBe(200);
    const open = openOf(openAfterSubmit) as Body;
    expect(open.id).toBe(inc.id);
    expect(open.status).toBe('active');
    expect(open.emergency_type).toBe('medical');
    expect(open).toHaveProperty('delivered_count');
    expect(open).toHaveProperty('acknowledged_count');
    expect(open).not.toHaveProperty('submit_outcome');
    expect(open.location_sharing_ended_at).toBeNull();
    expect(open.id).not.toBe(otherId);
  });

  it('L128: default recent list wrong: %', () => {
    expect(defaultList.statusCode).toBe(200);
    const list = recentOf(defaultList);
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({ id: inc.id, status: 'active' });
    expect(list[1]).toMatchObject({ id: ids[6], status: 'resolved', resolved_reason: 'safe' });
    expect(list[1].resolved_at).not.toBeNull();
    expect(list[4].id).toBe(ids[3]);
  });

  it('L137: recent list keys wrong: %', () => {
    expect(Object.keys(recentOf(defaultList)[1]).sort()).toEqual([
      'activated_at',
      'emergency_type',
      'id',
      'resolved_at',
      'resolved_reason',
      'sent_at',
      'status',
    ]);
  });

  it('L144: recent list leaked another user or cancelled', () => {
    const list = recentOf(list20);
    expect(list.filter((e) => e.id === otherId || e.status === 'cancelled')).toEqual([]);
  });

  it('L148: limit 20 should return all 8', () => {
    expect(recentOf(list20)).toHaveLength(8);
  });

  it('L151: limit 500 should clamp to 20 and return 8', () => {
    expect(list500.statusCode).toBe(200);
    expect(recentOf(list500)).toHaveLength(8);
  });

  it('L155: limit <= 0 should clamp to 1', () => {
    expect(recentOf(list0)).toHaveLength(1);
    expect(recentOf(listMinus3)).toHaveLength(1);
  });

  it('L158: null limit should default to 5', () => {
    expect(recentOf(listNull)).toHaveLength(5);
  });

  it('L165: open read after mark safe should be null: %', () => {
    expect(openAfterSafe.statusCode).toBe(200);
    expect(openAfterSafe.json()).toEqual({ open_incident: null });
  });

  it('L171: completed incident not first in recent: %', () => {
    const list = recentOf(list1AfterSafe);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: inc.id, status: 'resolved' });
  });

  it('L176: unexpected incident count %', async () => {
    const n = await countRows(
      client,
      `select count(*)::int as n from public.incidents where resident_id = $1`,
      [resident.id],
    );
    expect(n).toBe(9);
  });
});
