import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient, testDatabaseUrl } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import {
  countRows,
  getOpenIncident,
  listRecentIncidents,
  markSafe,
  submitAlert,
} from '../support/incident-api';

/**
 * `GET /v1/me/incidents/open` and `GET /v1/me/incidents` (API-100-16): the wrapper, status
 * filters, ordering ties, limit validation, ownership, consistency with submit, reads racing
 * writes, and the AC5 latency budget.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof getOpenIncident>>;

const POSTGRES_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/;
const RECENT_KEYS = [
  'activated_at',
  // SCRUM-63 (D61, D63).
  'auto_closed',
  'closed_at',
  'emergency_type',
  'id',
  'resolved_at',
  'resolved_reason',
  'sent_at',
  'status',
];

describe('resident incident reads (API-100-16)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const errorOf = (reply: Reply) => reply.json<{ error: { code: string; details: Body } }>().error;
  const openOf = (reply: Reply) => reply.json<{ open_incident: Body | null }>().open_incident;

  async function residentWithCircle(members = 1): Promise<{
    resident: UserFixture;
    circle: CircleFixture;
    memberUsers: UserFixture[];
  }> {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const memberUsers: UserFixture[] = [];
    for (let i = 0; i < members; i++) {
      const user = await createUser(client);
      await addActiveMember(client, circle, user);
      memberUsers.push(user);
    }
    return { resident, circle, memberUsers };
  }

  /** A row written directly: legacy statuses cannot be created through the API. */
  async function insertIncident(
    residentId: string,
    status: 'active' | 'resolved' | 'cancelled' | 'activating',
    activatedAt = 'now()',
    id?: string,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.incidents (id, resident_id, status, emergency_type, activated_at, sent_at,
                                     resolved_at, resolved_reason, cancelled_at)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3,
               case when $3 in ('cancelled', 'activating') then 'unspecified' else 'fire' end,
               ${activatedAt}, case when $3 in ('active', 'resolved') then ${activatedAt} end,
               case when $3 = 'resolved' then now() end,
               case when $3 = 'resolved' then 'safe' end,
               case when $3 = 'cancelled' then now() end)
       returning id`,
      [id ?? null, residentId, status],
    );
    return rows[0].id;
  }

  /** Resolves within `ms`, or rejects: proves a read is not waiting on a writer's lock. */
  const within = <T>(ms: number, promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms),
      ),
    ]);

  const httpGet = async (path: string, userId: string) => {
    const response = await fetch(`${baseUrl}${path}`, { headers: await authHeader(userId) });
    return { status: response.status, body: (await response.json()) as unknown };
  };

  describe('AC4: authentication', () => {
    it.each([
      ['/v1/me/incidents/open', 'get_my_open_incident:not_authenticated'],
      ['/v1/me/incidents', 'list_my_recent_incidents:not_authenticated'],
      ['/v1/me/incidents?limit=abc', 'list_my_recent_incidents:not_authenticated'],
    ])('%s without a token is 401 %s', async (url, code) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe(code);
    });

    it('an expired token is 401 with the operation code', async () => {
      const { id } = await createUser(client);
      for (const [url, code] of [
        ['/v1/me/incidents/open', 'get_my_open_incident:not_authenticated'],
        ['/v1/me/incidents', 'list_my_recent_incidents:not_authenticated'],
      ]) {
        const res = await app.inject({
          method: 'GET',
          url,
          headers: await authHeader(id, { expiresInSeconds: -60 }),
        });
        expect(res.statusCode).toBe(401);
        expect(errorOf(res).code).toBe(code);
      }
    });

    it('a valid token without a profile reads nothing', async () => {
      const noProfile = await createUser(client, { profile: false });
      expect((await getOpenIncident(app, noProfile.id)).json()).toEqual({ open_incident: null });
      expect((await listRecentIncidents(app, noProfile.id)).json()).toEqual([]);
    });
  });

  describe('AC1: open incident', () => {
    it('is always the wrapper: {"open_incident": null} when there is none', async () => {
      const { resident } = await residentWithCircle(0);
      const res = await getOpenIncident(app, resident.id);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body).toBe('{"open_incident":null}');
    });

    it('equals the submit body minus submit_outcome, byte for byte', async () => {
      const { resident } = await residentWithCircle(2);
      await client.query(
        `update public.profiles set blood_type = 'O+', share_blood_type = true where id = $1`,
        [resident.id],
      );
      const submit = await submitAlert(app, resident.id, 'domestic_violence');
      const res = await getOpenIncident(app, resident.id);

      const { submit_outcome: outcome, ...expected } = submit.json<Body>();
      expect(outcome).toBe('created');
      expect(Object.keys(openOf(res) as Body)).toEqual(Object.keys(expected));
      expect(res.body).toBe(`{"open_incident":${JSON.stringify(expected)}}`);
      expect((openOf(res) as Body).activated_at).toMatch(POSTGRES_UTC_TIMESTAMP);
    });

    it('also after a re-notify, with fresh counts', async () => {
      const { resident, memberUsers } = await residentWithCircle(2);
      const created = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      await client.query(
        `update public.incident_deliveries set acknowledged_at = now()
          where incident_id = $1 and member_user_id = $2`,
        [created.id, memberUsers[0].id],
      );
      const renotified = await submitAlert(app, resident.id, 'fire');
      const res = await getOpenIncident(app, resident.id);

      const { submit_outcome: outcome, ...expected } = renotified.json<Body>();
      expect(outcome).toBe('renotified');
      expect(res.body).toBe(`{"open_incident":${JSON.stringify(expected)}}`);
      expect(openOf(res)).toMatchObject({ delivered_count: 2, acknowledged_count: 1 });
    });

    it.each(['resolved', 'cancelled', 'activating'] as const)(
      'a %s incident is not open',
      async (status) => {
        const { resident } = await residentWithCircle(0);
        await insertIncident(resident.id, status);
        expect((await getOpenIncident(app, resident.id)).json()).toEqual({ open_incident: null });
      },
    );

    it('is null after mark safe; the next submit is the new open incident', async () => {
      const { resident } = await residentWithCircle(1);
      const first = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      await markSafe(app, resident.id, first.id as string);
      expect(openOf(await getOpenIncident(app, resident.id))).toBeNull();

      const second = (await submitAlert(app, resident.id, 'other')).json<Body>();
      expect(openOf(await getOpenIncident(app, resident.id))).toMatchObject({
        id: second.id,
        emergency_type: 'other',
      });
    });
  });

  describe('AC3: never another user', () => {
    it("a member never reads the resident's incident as their own, nor an outsider", async () => {
      const { resident, memberUsers } = await residentWithCircle(1);
      const outsider = await createUser(client);
      const incident = (await submitAlert(app, resident.id, 'fire')).json<Body>();

      for (const user of [memberUsers[0], outsider]) {
        expect((await getOpenIncident(app, user.id)).json()).toEqual({ open_incident: null });
        expect((await listRecentIncidents(app, user.id, 'limit=20')).json()).toEqual([]);
      }
      expect(openOf(await getOpenIncident(app, resident.id))).toMatchObject({ id: incident.id });
    });

    it("the member's own incident is the only one the member reads", async () => {
      const { resident, memberUsers } = await residentWithCircle(1);
      const residentIncident = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      const own = (await submitAlert(app, memberUsers[0].id, 'medical')).json<Body>();

      expect(openOf(await getOpenIncident(app, memberUsers[0].id))).toMatchObject({
        id: own.id,
        resident_id: memberUsers[0].id,
      });
      const list = (await listRecentIncidents(app, memberUsers[0].id, 'limit=20')).json<Body[]>();
      expect(list.map((e) => e.id)).toEqual([own.id]);
      expect(list.map((e) => e.id)).not.toContain(residentIncident.id);
    });
  });

  describe('AC2: recent incidents', () => {
    /** A resident with `n` resolved incidents a minute apart (newest last) and one open one. */
    async function residentWithHistory(n: number) {
      const resident = await createUser(client);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(
          await insertIncident(
            resident.id,
            'resolved',
            `now() - interval '1 day' + make_interval(mins => ${i})`,
          ),
        );
      }
      const open = (await submitAlert(app, resident.id, 'burglary')).json<Body>();
      return { resident, newestFirst: [open.id as string, ...ids.reverse()] };
    }

    it.each([
      ['missing', '', 5],
      ['1', 'limit=1', 1],
      ['20', 'limit=20', 20],
      ['25 (clamped)', 'limit=25', 20],
      ['0 (clamped)', 'limit=0', 1],
      ['-3 (clamped)', 'limit=-3', 1],
      ['+2', 'limit=%2B2', 2],
      ['int4 max', 'limit=2147483647', 20],
      ['int4 min', 'limit=-2147483648', 1],
      ['with an unknown parameter', 'limit=2&cursor=x', 2],
    ])('limit %s → %p entries, newest first', async (_label, query, expected) => {
      const { resident, newestFirst } = await residentWithHistory(22);
      const res = await listRecentIncidents(app, resident.id, query);
      expect(res.statusCode).toBe(200);
      expect(res.json<Body[]>().map((e) => e.id)).toEqual(newestFirst.slice(0, expected));
    });

    it.each([
      ['letters', 'limit=abc'],
      ['a decimal', 'limit=2.5'],
      ['empty', 'limit='],
      ['the word null', 'limit=null'],
      ['an exponent', 'limit=1e1'],
      ['out of int4 range', 'limit=2147483648'],
      ['repeated', 'limit=1&limit=2'],
    ])('limit %s is 422 validation:invalid_request on field limit', async (_label, query) => {
      const { id } = await createUser(client);
      const res = await listRecentIncidents(app, id, query);
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'limit' },
      });
    });

    it('only active and resolved; legacy cancelled and activating are left out', async () => {
      const resident = await createUser(client);
      const resolved = await insertIncident(resident.id, 'resolved', "now() - interval '2 hours'");
      await insertIncident(resident.id, 'cancelled', "now() + interval '1 hour'");
      const legacy = await insertIncident(resident.id, 'activating', "now() + interval '2 hours'");
      const list = async () =>
        (await listRecentIncidents(app, resident.id, 'limit=20'))
          .json<Body[]>()
          .map((e) => [e.id, e.status]);

      expect(await list()).toEqual([[resolved, 'resolved']]);

      // One open row per resident: the activating row becomes the active one.
      await client.query(
        `update public.incidents set status = 'active', emergency_type = 'fire', sent_at = now()
          where id = $1`,
        [legacy],
      );
      expect(await list()).toEqual([
        [legacy, 'active'],
        [resolved, 'resolved'],
      ]);
    });

    it('equal activated_at: id descending', async () => {
      const resident = await createUser(client);
      const sameInstant = "timestamptz '2026-11-01 12:00:00.123456+00'";
      const ids = [
        '00000000-0000-4000-8000-00000000000a',
        'ffffffff-0000-4000-8000-00000000000b',
        '80000000-0000-4000-8000-00000000000c',
      ];
      for (const id of ids) await insertIncident(resident.id, 'resolved', sameInstant, id);

      const list = (await listRecentIncidents(app, resident.id, 'limit=20')).json<Body[]>();
      expect(list.map((e) => e.id)).toEqual([...ids].sort().reverse());
    });

    it('entries have exactly the 7 keys, with database timestamps', async () => {
      const { resident } = await residentWithCircle(0);
      const created = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      const [entry] = (await listRecentIncidents(app, resident.id)).json<Body[]>();
      expect(Object.keys(entry).sort()).toEqual(RECENT_KEYS);
      expect(entry).toEqual({
        id: created.id,
        emergency_type: 'fire',
        status: 'active',
        activated_at: created.activated_at,
        sent_at: created.sent_at,
        resolved_at: null,
        resolved_reason: null,
        auto_closed: false,
        closed_at: null,
      });
    });
  });

  it('timestamps are UTC whatever the session default time zone is', async () => {
    const url = new URL(testDatabaseUrl());
    url.searchParams.set('options', '-c TimeZone=Asia/Kathmandu');
    const { app: otherZoneApp } = await createTestApp(
      {},
      withTestConfig({ DATABASE_URL: url.toString() }),
    );
    try {
      const { resident } = await residentWithCircle(0);
      await submitAlert(app, resident.id, 'fire');
      const open = openOf(await getOpenIncident(otherZoneApp, resident.id)) as Body;
      const [entry] = (await listRecentIncidents(otherZoneApp, resident.id)).json<Body[]>();
      expect(open.activated_at).toMatch(POSTGRES_UTC_TIMESTAMP);
      expect(entry.activated_at).toBe(open.activated_at);
    } finally {
      await otherZoneApp.close();
    }
  });

  it('reads write nothing', async () => {
    const { resident } = await residentWithCircle(2);
    const created = (await submitAlert(app, resident.id, 'fire')).json<Body>();
    const snapshot = async () => ({
      incident: (await client.query('select * from public.incidents where id = $1', [created.id]))
        .rows,
      deliveries: (
        await client.query(
          'select * from public.incident_deliveries where incident_id = $1 order by id',
          [created.id],
        )
      ).rows,
      events: await countRows(
        client,
        'select count(*)::int as n from public.incident_events where incident_id = $1',
        [created.id],
      ),
      audit: await countRows(
        client,
        'select count(*)::int as n from public.audit_log where target_id = $1',
        [created.id],
      ),
    });
    const before = await snapshot();
    await getOpenIncident(app, resident.id);
    await listRecentIncidents(app, resident.id, 'limit=20');
    expect(await snapshot()).toEqual(before);
  });

  describe('reads racing writes (separate connections)', () => {
    /**
     * Begins a transaction on a new connection and runs `statements` in it, uncommitted (the rows a
     * submit or a mark safe writes, held open).
     */
    async function uncommitted(statements: Array<[string, unknown[]]>) {
      const writer = await openTestClient();
      await writer.query('begin');
      for (const [text, params] of statements) await writer.query(text, params);
      return {
        commit: async () => {
          await writer.query('commit');
          await writer.end();
        },
      };
    }

    it('a submit in flight is invisible until it commits, and the read never waits', async () => {
      const { resident } = await residentWithCircle(3);
      // A submit's rows: the incident and one delivery per active member, in one transaction.
      const submit = await uncommitted([
        [
          `with i as (
             insert into public.incidents (resident_id, circle_id, status, emergency_type, sent_at)
             select c.owner_id, c.id, 'active', 'fire', now()
               from public.safety_circles c where c.owner_id = $1
             returning id, circle_id)
           insert into public.incident_deliveries (incident_id, member_id, member_user_id)
           select i.id, m.id, m.user_id
             from i join public.safety_circle_members m on m.circle_id = i.circle_id
            where m.role = 'member' and m.status = 'active'`,
          [resident.id],
        ],
      ]);

      const during = await within(2_000, httpGet('/v1/me/incidents/open', resident.id));
      const listDuring = await within(2_000, httpGet('/v1/me/incidents', resident.id));
      await submit.commit();
      const after = await getOpenIncident(app, resident.id);

      expect(during).toEqual({ status: 200, body: { open_incident: null } });
      expect(listDuring).toEqual({ status: 200, body: [] });
      // The incident and all its deliveries arrive together (one transaction, one statement).
      expect(openOf(after)).toMatchObject({ status: 'active', delivered_count: 3 });
    });

    it('a mark safe in flight: still open until it commits, then null', async () => {
      const { resident } = await residentWithCircle(1);
      const created = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      // Mark safe's close (IncidentStateService), held open.
      const close = await uncommitted([
        [
          `update public.incidents
              set status = 'resolved', resolved_at = now(), resolved_reason = 'safe',
                  auto_closed = false, location_sharing_ended_at = now()
            where id = $1 and status = 'active'`,
          [created.id],
        ],
      ]);

      const during = await within(2_000, httpGet('/v1/me/incidents/open', resident.id));
      const listDuring = await within(2_000, httpGet('/v1/me/incidents', resident.id));
      await close.commit();
      const after = await getOpenIncident(app, resident.id);
      const listAfter = (await listRecentIncidents(app, resident.id)).json<Body[]>();

      expect(during.status).toBe(200);
      expect((during.body as { open_incident: Body }).open_incident).toMatchObject({
        id: created.id,
        status: 'active',
        resolved_at: null,
      });
      expect((listDuring.body as Body[])[0]).toMatchObject({ id: created.id, status: 'active' });
      expect(after.json()).toEqual({ open_incident: null });
      expect(listAfter[0]).toMatchObject({ id: created.id, status: 'resolved' });
    });

    it('reads while the submit row locks are held (profile and incident) do not wait', async () => {
      const { resident } = await residentWithCircle(1);
      const created = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      const holder = await openTestClient();
      await holder.query('begin');
      await holder.query('select 1 from public.profiles where id = $1 for update', [resident.id]);
      await holder.query('select 1 from public.incidents where id = $1 for update', [created.id]);
      try {
        const res = await within(2_000, httpGet('/v1/me/incidents/open', resident.id));
        expect((res.body as { open_incident: Body }).open_incident).toMatchObject({
          id: created.id,
        });
      } finally {
        await holder.query('rollback');
        await holder.end();
      }
    });
  });

  it('AC5: p99 of the open read stays under 500 ms with realistic data', async () => {
    const { resident } = await residentWithCircle(5);
    // Other residents' history around the caller's rows.
    await client.query(
      `with users as (
         insert into public.users (id, email)
         select gen_random_uuid(), 'load-' || gen_random_uuid() || '@example.test'
           from generate_series(1, 500)
         returning id),
       profiles as (
         insert into public.profiles (id, full_name, date_of_birth)
         select id, 'Load User', date '1990-01-01' from users
         returning id)
       insert into public.incidents (resident_id, status, emergency_type, activated_at, sent_at,
                                     resolved_at, resolved_reason)
       select u.id, 'resolved', 'fire', now() - make_interval(hours => g), now() - make_interval(hours => g),
              now(), 'safe'
         from profiles u cross join generate_series(1, 10) g`,
    );
    for (let i = 0; i < 30; i++) {
      await insertIncident(resident.id, 'resolved', `now() - make_interval(days => ${i + 1})`);
    }
    await submitAlert(app, resident.id, 'fire');

    const timings: number[] = [];
    for (let i = 0; i < 300; i++) {
      const start = performance.now();
      const res = await httpGet('/v1/me/incidents/open', resident.id);
      timings.push(performance.now() - start);
      expect(res.status).toBe(200);
    }
    timings.sort((a, b) => a - b);
    const p99 = timings[Math.ceil(timings.length * 0.99) - 1];
    expect(p99).toBeLessThan(500);
  });
});
