import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AuditService } from '../../src/modules/audit';
import {
  INCIDENT_POST_COMMIT_HOOKS,
  type IncidentResolvedEvent,
} from '../../src/modules/incidents/incident-post-commit';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
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
  callSqlAs,
  countRows,
  markSafe,
  markSafeViaSql,
  submitAlert,
  submitAlertViaSql,
} from '../support/incident-api';

/**
 * `POST /v1/incidents/{id}/mark-safe` (API-100-19) beyond the SQL scripts: check order, the
 * already-safe no-op writing nothing, the closure recipients of rule 54 (including the window case of
 * membership_access_window: members who joined after the incident started are not told it closed),
 * audit and post-commit hooks, idempotency, races and the submit lock order (no deadlock), and
 * interchangeability with the SQL function `mark_incident_safe`.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof markSafe>>;

const PARALLEL = 10;
/** Rounds of each mark-safe-versus-submit race. */
const RACE_ROUNDS = 40;
/** Mark-safe calls timed for AC8. */
const LATENCY_SAMPLES = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replaced by each hook test; reset before every test. */
let hookBehaviour: (event: IncidentResolvedEvent) => void | Promise<void>;
const hookCalls: IncidentResolvedEvent[] = [];

describe('POST /v1/incidents/{id}/mark-safe (API-100-19)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({}, (builder) =>
      withTestConfig({ DATABASE_POOL_MAX: String(PARALLEL * 3) })(builder)
        .overrideProvider(INCIDENT_POST_COMMIT_HOOKS)
        .useValue([
          {
            afterResolved: (event: IncidentResolvedEvent) => {
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

  /** A resident whose circle has `members` active members, with an alert open through the API. */
  async function activeAlert(members = 2): Promise<{
    resident: UserFixture;
    circle: CircleFixture;
    memberUsers: UserFixture[];
    incidentId: string;
  }> {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const memberUsers: UserFixture[] = [];
    for (let i = 0; i < members; i++) {
      const user = await createUser(client);
      await addActiveMember(client, circle, user);
      memberUsers.push(user);
    }
    const incident = (await submitAlert(app, resident.id, 'medical')).json<Body>();
    return { resident, circle, memberUsers, incidentId: incident.id as string };
  }

  /** A legacy row in a state the API cannot create. */
  async function legacyIncident(kind: 'activating' | 'cancelled' | 'ended') {
    const resident = await createUser(client);
    const { rows } = await client.query<{ id: string }>(
      `insert into public.incidents (resident_id, status, emergency_type, cancelled_at,
                                     resolved_at, resolved_reason, location_sharing_ended_at)
       values ($1,
               case $2 when 'ended' then 'resolved' else $2 end,
               'unspecified',
               case when $2 = 'cancelled' then now() end,
               case when $2 = 'ended' then now() end,
               case when $2 = 'ended' then 'ended' end,
               case when $2 = 'ended' then now() end)
       returning id`,
      [resident.id, kind],
    );
    return { resident, incidentId: rows[0].id };
  }

  /** Everything mark safe could write for one incident, as the database holds it. */
  async function snapshot(incidentId: string) {
    const query = async (sql: string) => (await client.query<Body>(sql, [incidentId])).rows;
    return {
      incident: await query('select * from public.incidents where id = $1'),
      events: await query(
        'select * from public.incident_events where incident_id = $1 order by id',
      ),
      deliveries: await query(
        'select * from public.incident_deliveries where incident_id = $1 order by id',
      ),
      audit: await query('select * from public.audit_log where target_id = $1 order by id'),
    };
  }

  const viaSendJson = async (incidentId: string) => {
    await client.query(`set timezone = 'UTC'`);
    const { rows } = await client.query<{ body: Body }>(
      'select public._incident_send_json(i) as body from public.incidents i where i.id = $1',
      [incidentId],
    );
    return rows[0].body;
  };

  const eventCount = (incidentId: string, eventType: string) =>
    countRows(
      client,
      `select count(*)::int as n from public.incident_events
        where incident_id = $1 and event_type = $2`,
      [incidentId, eventType],
    );

  const closureDetail = async (incidentId: string) => {
    const { rows } = await client.query<{
      detail: { recipient_count: number; recipient_ids: string[] };
    }>(
      `select detail from public.incident_events
        where incident_id = $1 and event_type = 'closure_notified'`,
      [incidentId],
    );
    return rows[0]?.detail;
  };

  /** Exactly one of each closure event and of the two submit events (re-notifies aside). */
  async function expectClosedOnce(incidentId: string) {
    const { rows } = await client.query<{ event_type: string; n: number }>(
      `select event_type, count(*)::int as n from public.incident_events
        where incident_id = $1 and event_type <> 'renotified'
        group by event_type order by event_type`,
      [incidentId],
    );
    expect(rows).toEqual([
      { event_type: 'alert_sent', n: 1 },
      { event_type: 'closure_notified', n: 1 },
      { event_type: 'incident_closed', n: 1 },
      { event_type: 'location_sharing_ended', n: 1 },
      { event_type: 'location_sharing_started', n: 1 },
      { event_type: 'safe_recorded', n: 1 },
    ]);
    const { rows: incident } = await client.query<Body>(
      'select status, resolved_reason from public.incidents where id = $1',
      [incidentId],
    );
    expect(incident[0]).toEqual({ status: 'resolved', resolved_reason: 'safe' });
  }

  /** A real HTTP request over its own socket. */
  async function httpMarkSafe(userId: string, incidentId: string, key: string = randomUUID()) {
    const response = await fetch(`${baseUrl}/v1/incidents/${incidentId}/mark-safe`, {
      method: 'POST',
      headers: { ...(await authHeader(userId)), 'idempotency-key': key },
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  async function httpSubmit(userId: string, type: string) {
    const response = await fetch(`${baseUrl}/v1/incidents`, {
      method: 'POST',
      headers: {
        ...(await authHeader(userId)),
        'idempotency-key': randomUUID(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ emergency_type: type }),
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  /** Waits until `count` backends of this database are blocked on a lock. */
  async function waitForLockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const waiting = await countRows(
        client,
        `select count(distinct pid)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (waiting >= count) return;
      if (Date.now() > deadline) throw new Error(`only ${waiting} of ${count} backends waiting`);
      await sleep(10);
    }
  }

  /** Holds the resident's profile row `FOR UPDATE` (submit's first lock) until released. */
  async function holdProfileLock(residentId: string) {
    const holder = await openTestClient();
    await holder.query('begin');
    await holder.query('select 1 from public.profiles where id = $1 for update', [residentId]);
    return {
      holder,
      release: async () => {
        await holder.query('commit');
        await holder.end();
      },
    };
  }

  const waitForHook = async (count = 1) => {
    const deadline = Date.now() + 5_000;
    while (hookCalls.length < count && Date.now() < deadline) await sleep(5);
    expect(hookCalls).toHaveLength(count);
  };

  describe('AC1, AC2: request and check order', () => {
    it('no token: 401 mark_incident_safe:not_authenticated, before the key is looked at', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/incidents/${randomUUID()}/mark-safe`,
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('mark_incident_safe:not_authenticated');
    });

    it('a missing Idempotency-Key is 400 idempotency:key_required and closes nothing', async () => {
      const { resident, incidentId } = await activeAlert();
      const res = await markSafe(app, resident.id, incidentId, null);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('idempotency:key_required');
      expect(await eventCount(incidentId, 'safe_recorded')).toBe(0);
    });

    it('a key that is not a UUID is 422 idempotency:invalid_key', async () => {
      const { resident, incidentId } = await activeAlert();
      const res = await markSafe(app, resident.id, incidentId, 'not-a-uuid');
      expect(res.statusCode).toBe(422);
      expect(errorOf(res).code).toBe('idempotency:invalid_key');
    });

    it('an invalid {id} is 422 validation:invalid_request on field id', async () => {
      const { id } = await createUser(client);
      for (const bad of ['abc', '1234', `${randomUUID()}x`]) {
        const res = await markSafe(app, id, bad);
        expect(res.statusCode).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'validation:invalid_request',
          details: { field: 'id' },
        });
      }
    });

    it('accepts every uuid spelling Postgres accepts', async () => {
      const { resident, incidentId } = await activeAlert();
      const res = await markSafe(app, resident.id, `{${incidentId.toUpperCase()}}`);
      expect(res.statusCode).toBe(200);
      expect(res.json<Body>()).toMatchObject({ id: incidentId, status: 'resolved' });
    });

    it("unknown, another resident's, or a member's: 404 not_found, nothing written", async () => {
      const { incidentId, memberUsers } = await activeAlert();
      const outsider = await createUser(client);
      const before = await snapshot(incidentId);
      for (const [userId, id] of [
        [outsider.id, randomUUID()],
        [outsider.id, incidentId],
        [memberUsers[0].id, incidentId],
      ]) {
        const res = await markSafe(app, userId, id);
        expect(res.statusCode).toBe(404);
        expect(errorOf(res).code).toBe('mark_incident_safe:not_found');
      }
      expect(await snapshot(incidentId)).toEqual(before);
      expect(hookCalls).toEqual([]);
    });

    it("not_found comes before not_open (someone else's legacy incident)", async () => {
      const legacy = await legacyIncident('cancelled');
      const other = await createUser(client);
      const res = await markSafe(app, other.id, legacy.incidentId);
      expect(errorOf(res).code).toBe('mark_incident_safe:not_found');
    });
  });

  describe('AC3: already resolved as safe', () => {
    it('200 with the unchanged IncidentSend; no events, timestamps, deliveries, audit or hook', async () => {
      const { resident, incidentId } = await activeAlert(2);
      const first = await markSafe(app, resident.id, incidentId);
      await waitForHook();
      hookCalls.length = 0;
      const before = await snapshot(incidentId);

      const again = await markSafe(app, resident.id, incidentId);

      expect(again.statusCode).toBe(200);
      expect(again.headers['idempotent-replayed']).toBeUndefined();
      expect(again.body).toBe(first.body);
      expect(again.body).toBe(JSON.stringify(await viaSendJson(incidentId)));
      expect(await snapshot(incidentId)).toEqual(before);
      await sleep(50);
      expect(hookCalls).toEqual([]);
    });

    it('also when the SQL function closed it', async () => {
      const { resident, incidentId } = await activeAlert(1);
      const closed = await markSafeViaSql(client, resident.id, incidentId);
      const before = await snapshot(incidentId);
      const res = await markSafe(app, resident.id, incidentId);
      expect(res.statusCode).toBe(200);
      expect(res.json<Body>()).toEqual(closed);
      expect(await snapshot(incidentId)).toEqual(before);
    });
  });

  describe('AC4: not active', () => {
    it.each(['activating', 'cancelled', 'ended'] as const)(
      'legacy %s: 409 mark_incident_safe:not_open, nothing written',
      async (kind) => {
        const { resident, incidentId } = await legacyIncident(kind);
        const before = await snapshot(incidentId);
        const res = await markSafe(app, resident.id, incidentId);
        expect(res.statusCode).toBe(409);
        expect(errorOf(res).code).toBe('mark_incident_safe:not_open');
        expect(await snapshot(incidentId)).toEqual(before);
        expect(hookCalls).toEqual([]);
      },
    );
  });

  describe('AC5, AC6: the close', () => {
    it('one transaction: columns, the four events and IncidentSend from the SQL helper', async () => {
      const { resident, memberUsers, incidentId } = await activeAlert(3);
      await client.query(
        `update public.incident_deliveries set acknowledged_at = now()
          where incident_id = $1 and member_user_id = $2`,
        [incidentId, memberUsers[0].id],
      );
      const { rows: beforeRows } = await client.query<Body>(
        `select emergency_type, share_payload, circle_id, activated_at, sent_at, location_lat,
                incident_notes, renotified_at
           from public.incidents where id = $1`,
        [incidentId],
      );

      const res = await markSafe(app, resident.id, incidentId);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(JSON.stringify(await viaSendJson(incidentId)));
      expect(res.json<Body>()).toMatchObject({
        id: incidentId,
        status: 'resolved',
        resolved_reason: 'safe',
        auto_closed: false,
        delivered_count: 3,
        acknowledged_count: 1,
      });
      expect(Object.keys(res.json<Body>())).toHaveLength(24);

      const { rows } = await client.query<Body>(
        `select status, resolved_reason, auto_closed,
                resolved_at = location_sharing_ended_at as same_stamp,
                resolved_at is not null as resolved,
                emergency_type, share_payload, circle_id, activated_at, sent_at, location_lat,
                incident_notes, renotified_at
           from public.incidents where id = $1`,
        [incidentId],
      );
      const { status, resolved_reason, auto_closed, same_stamp, resolved, ...rest } = rows[0];
      expect({ status, resolved_reason, auto_closed, same_stamp, resolved }).toEqual({
        status: 'resolved',
        resolved_reason: 'safe',
        auto_closed: false,
        same_stamp: true,
        resolved: true,
      });
      expect(rest).toEqual(beforeRows[0]);

      const { rows: events } = await client.query<Body>(
        `select e.event_type, e.detail, e.actor_id, e.occurred_at = i.resolved_at as at_close
           from public.incident_events e join public.incidents i on i.id = e.incident_id
          where e.incident_id = $1
            and e.event_type not in ('alert_sent', 'location_sharing_started')
          order by e.event_type`,
        [incidentId],
      );
      const sortedIds = memberUsers.map((user) => user.id).sort();
      expect(events).toEqual([
        {
          event_type: 'closure_notified',
          detail: { recipient_count: 3, recipient_ids: sortedIds },
          actor_id: resident.id,
          at_close: true,
        },
        {
          event_type: 'incident_closed',
          detail: { resolved_reason: 'safe' },
          actor_id: resident.id,
          at_close: true,
        },
        { event_type: 'location_sharing_ended', detail: {}, actor_id: resident.id, at_close: true },
        { event_type: 'safe_recorded', detail: {}, actor_id: resident.id, at_close: true },
      ]);
    });

    it('recipients: active members with an account, never the resident, pending, declined or removed', async () => {
      const { resident, circle, memberUsers, incidentId } = await activeAlert(2);
      // Pending phone invite, a claimed pending invite, a declined row with an account.
      await inviteMember(client, circle);
      const claimer = await createUser(client);
      await inviteMember(client, circle, { claimedBy: claimer });
      const decliner = await createUser(client);
      const declined = await inviteMember(client, circle, { claimedBy: decliner });
      await client.query(
        `update public.safety_circle_members
            set status = 'declined', invite_canceled_at = now() where id = $1`,
        [declined.id],
      );
      // An active member removed before the close (hard delete, as remove_circle_member does).
      await client.query(
        `delete from public.safety_circle_members where circle_id = $1 and user_id = $2`,
        [circle.id, memberUsers[1].id],
      );

      await markSafe(app, resident.id, incidentId);

      expect(await closureDetail(incidentId)).toEqual({
        recipient_count: 1,
        recipient_ids: [memberUsers[0].id],
      });
    });

    it('no circle: success, recipient_count 0 and recipient_ids []', async () => {
      const resident = await createUser(client);
      const incidentId = (await submitAlert(app, resident.id, 'fire')).json<Body>().id as string;
      const res = await markSafe(app, resident.id, incidentId);
      expect(res.statusCode).toBe(200);
      expect(res.json<Body>()).toMatchObject({ circle_id: null, delivered_count: 0 });
      expect(await closureDetail(incidentId)).toEqual({ recipient_count: 0, recipient_ids: [] });
    });

    it('ids are sorted by Postgres uuid order', async () => {
      const { resident, memberUsers, incidentId } = await activeAlert(5);
      await markSafe(app, resident.id, incidentId);
      const { rows } = await client.query<{ ids: string[] }>(
        `select array_agg(id::text order by id) as ids from unnest($1::uuid[]) as id`,
        [memberUsers.map((user) => user.id)],
      );
      expect((await closureDetail(incidentId))?.recipient_ids).toEqual(rows[0].ids);
    });
  });

  describe('rule 54 closure recipients (membership_access_window, window case)', () => {
    /** Sets a member row's activation relative to the incident start (trusted maintenance path). */
    const setActivation = (circleId: string, userId: string, incidentId: string, offset: string) =>
      client.query(
        `update public.safety_circle_members m
            set activated_at = i.activated_at + $4::interval
           from public.incidents i
          where m.circle_id = $1 and m.user_id = $2 and i.id = $3`,
        [circleId, userId, incidentId, offset],
      );

    it('joined at the instant the incident started: told; 1 µs later: not told', async () => {
      const { resident, circle, memberUsers, incidentId } = await activeAlert(4);
      const [before, equal, after, later] = memberUsers;
      await setActivation(circle.id, before.id, incidentId, '-1 microsecond');
      await setActivation(circle.id, equal.id, incidentId, '0');
      await setActivation(circle.id, after.id, incidentId, '1 microsecond');
      await setActivation(circle.id, later.id, incidentId, '1 day');

      await markSafe(app, resident.id, incidentId);

      expect(await closureDetail(incidentId)).toEqual({
        recipient_count: 2,
        recipient_ids: [before.id, equal.id].sort(),
      });
    });

    it('a member who joined while the alert was open is not told it closed (no delivery either)', async () => {
      const { resident, circle, memberUsers, incidentId } = await activeAlert(1);
      const joiner = await createUser(client);
      await addActiveMember(client, circle, joiner);

      await markSafe(app, resident.id, incidentId);

      expect(await closureDetail(incidentId)).toEqual({
        recipient_count: 1,
        recipient_ids: [memberUsers[0].id],
      });
    });

    it('the same recipients as the SQL helper for every boundary', async () => {
      const [a, b] = [await activeAlert(4), await activeAlert(4)];
      for (const twin of [a, b]) {
        const offsets = ['-1 microsecond', '0', '1 microsecond', '1 day'];
        for (const [i, user] of twin.memberUsers.entries()) {
          await setActivation(twin.circle.id, user.id, twin.incidentId, offsets[i]);
        }
      }
      await markSafe(app, a.resident.id, a.incidentId);
      await markSafeViaSql(client, b.resident.id, b.incidentId);
      const positions = async (twin: typeof a) =>
        ((await closureDetail(twin.incidentId))?.recipient_ids ?? []).map((id) =>
          twin.memberUsers.findIndex((user) => user.id === id),
        );
      expect((await positions(a)).sort()).toEqual([0, 1]);
      expect((await positions(b)).sort()).toEqual([0, 1]);
    });
  });

  describe('audit', () => {
    it('incident.resolved once, with the recipient count only', async () => {
      const { resident, incidentId } = await activeAlert(2);
      await client.query(
        `update public.profiles set allergies = 'Peanuts', share_allergies = true where id = $1`,
        [resident.id],
      );
      const start = logs.text.length;
      await markSafe(app, resident.id, incidentId);
      await markSafe(app, resident.id, incidentId);

      const { rows } = await client.query<Body>(
        `select action, actor_user_id, target_type, request_id, detail
           from public.audit_log where target_id = $1 and action = 'incident.resolved'`,
        [incidentId],
      );
      expect(rows).toEqual([
        {
          action: 'incident.resolved',
          actor_user_id: resident.id,
          target_type: 'incident',
          request_id: expect.any(String) as unknown,
          detail: { recipient_count: 2 },
        },
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/medical|Peanuts|share|lat/);
      expect(logs.text.slice(start)).not.toContain('medical');
    });

    it('a failure inside the transaction rolls everything back, hides its detail, runs no hook', async () => {
      const { resident, incidentId } = await activeAlert(1);
      const marker = 'params-sentinel-domestic_violence';
      jest
        .spyOn(app.get(AuditService), 'record')
        .mockRejectedValueOnce(new Error(`Failed query\nparams: ${marker}`));
      const before = await snapshot(incidentId);

      const res = await markSafe(app, resident.id, incidentId);

      expect(res.statusCode).toBe(500);
      expect(errorOf(res).code).toBe('internal:error');
      expect(res.body).not.toContain(marker);
      expect(logs.text).not.toContain(marker);
      expect(await snapshot(incidentId)).toEqual(before);
      await sleep(50);
      expect(hookCalls).toEqual([]);
      // The retry after a 5xx closes it (the key was released).
      expect((await markSafe(app, resident.id, incidentId)).statusCode).toBe(200);
      await expectClosedOnce(incidentId);
    });
  });

  describe('AC7: post-commit hook incident.resolved', () => {
    it('runs after commit with ids and the count only', async () => {
      const { resident, circle, incidentId } = await activeAlert(2);
      let seen: Body | undefined;
      hookBehaviour = async (event) => {
        const { rows } = await client.query<Body>(
          'select status from public.incidents where id = $1',
          [event.incident_id],
        );
        seen = rows[0];
      };

      await markSafe(app, resident.id, incidentId);
      await waitForHook();
      for (let i = 0; i < 200 && !seen; i++) await sleep(5);

      expect(seen).toEqual({ status: 'resolved' });
      expect(hookCalls).toEqual([
        {
          incident_id: incidentId,
          resident_id: resident.id,
          circle_id: circle.id,
          recipient_count: 2,
        },
      ]);
    });

    it.each([
      [
        'throws',
        () => {
          throw new Error('hook exploded');
        },
      ],
      ['rejects', () => Promise.reject(new Error('hook exploded'))],
      ['never finishes', () => new Promise<void>(() => undefined)],
    ])('a hook that %s never fails or holds the committed close', async (_label, behaviour) => {
      const { resident, incidentId } = await activeAlert(1);
      hookBehaviour = behaviour;
      const res = await markSafe(app, resident.id, incidentId);
      expect(res.statusCode).toBe(200);
      await waitForHook();
      await expectClosedOnce(incidentId);
    });

    it('does not run for errors, the no-op or a replay', async () => {
      const { resident, incidentId } = await activeAlert(1);
      const key = randomUUID();
      await markSafe(app, resident.id, incidentId, key);
      await waitForHook();
      hookCalls.length = 0;
      await markSafe(app, resident.id, incidentId, key);
      await markSafe(app, resident.id, incidentId);
      await markSafe(app, resident.id, randomUUID());
      await sleep(50);
      expect(hookCalls).toEqual([]);
    });
  });

  describe('idempotency', () => {
    it('the same key replays the first response; nothing is written again', async () => {
      const { resident, incidentId } = await activeAlert(2);
      const key = randomUUID();
      const first = await markSafe(app, resident.id, incidentId, key);
      const before = await snapshot(incidentId);

      const replay = await markSafe(app, resident.id, incidentId, key);

      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      expect(await snapshot(incidentId)).toEqual(before);
    });

    it('a new key after the close is the AC3 no-op (not a replay)', async () => {
      const { resident, incidentId } = await activeAlert(2);
      const first = await markSafe(app, resident.id, incidentId);
      const before = await snapshot(incidentId);
      const second = await markSafe(app, resident.id, incidentId);
      expect(second.statusCode).toBe(200);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(second.body).toBe(first.body);
      expect(await snapshot(incidentId)).toEqual(before);
    });

    it('the same key on another incident is 422 idempotency:key_mismatch', async () => {
      const a = await activeAlert(1);
      const key = randomUUID();
      await markSafe(app, a.resident.id, a.incidentId, key);
      const res = await markSafe(app, a.resident.id, randomUUID(), key);
      expect(res.statusCode).toBe(422);
      expect(errorOf(res).code).toBe('idempotency:key_mismatch');
    });

    it('an error response is replayed too', async () => {
      const resident = await createUser(client);
      const key = randomUUID();
      const id = randomUUID();
      const first = await markSafe(app, resident.id, id, key);
      const replay = await markSafe(app, resident.id, id, key);
      expect(first.statusCode).toBe(404);
      expect(replay.statusCode).toBe(404);
      expect(replay.headers['idempotent-replayed']).toBe('true');
    });
  });

  describe('races on separate connections', () => {
    it(`a double tap with different keys (${PARALLEL} calls): closed once, every call 200`, async () => {
      const { resident, incidentId } = await activeAlert(2);
      const lock = await holdProfileLock(resident.id);
      const calls = Array.from({ length: PARALLEL }, () => httpMarkSafe(resident.id, incidentId));
      await waitForLockWaiters(PARALLEL);
      await lock.release();
      const replies = await Promise.all(calls);

      expect(replies.map((reply) => reply.status)).toEqual(Array(PARALLEL).fill(200));
      expect(new Set(replies.map((reply) => reply.body.resolved_at)).size).toBe(1);
      await expectClosedOnce(incidentId);
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.audit_log
            where target_id = $1 and action = 'incident.resolved'`,
          [incidentId],
        ),
      ).toBe(1);
      await waitForHook(1);
      await sleep(50);
      expect(hookCalls).toHaveLength(1);
    });

    it('a double tap with the same key: one close; the others in_progress or the replay', async () => {
      const { resident, incidentId } = await activeAlert(2);
      const key = randomUUID();
      const lock = await holdProfileLock(resident.id);
      const first = httpMarkSafe(resident.id, incidentId, key);
      await waitForLockWaiters(1);
      const duplicates = await Promise.all(
        Array.from({ length: 3 }, () => httpMarkSafe(resident.id, incidentId, key)),
      );
      await lock.release();
      const done = await first;
      const replay = await httpMarkSafe(resident.id, incidentId, key);

      expect(done.status).toBe(200);
      for (const duplicate of duplicates) {
        expect(duplicate.status).toBe(409);
        expect((duplicate.body.error as { code: string }).code).toBe('idempotency:in_progress');
      }
      expect(replay).toEqual(done);
      await expectClosedOnce(incidentId);
    });

    it('API and SQL closes racing: closed once, every caller gets the closed incident', async () => {
      const { resident, incidentId } = await activeAlert(2);
      const sqlClients = await Promise.all(
        Array.from({ length: PARALLEL / 2 }, () => openTestClient()),
      );
      try {
        const lock = await holdProfileLock(resident.id);
        const api = Array.from({ length: PARALLEL / 2 }, () =>
          httpMarkSafe(resident.id, incidentId),
        );
        // The SQL function locks the incident first and then waits on the profile (its events'
        // foreign key), so start it once the API calls are queued on the profile.
        await waitForLockWaiters(PARALLEL / 2);
        const viaSql = sqlClients.map((sqlClient) =>
          markSafeViaSql(sqlClient, resident.id, incidentId),
        );
        await waitForLockWaiters(PARALLEL);
        await lock.release();
        const [apiReplies, sqlReplies] = await Promise.all([Promise.all(api), Promise.all(viaSql)]);
        expect(apiReplies.map((reply) => reply.status)).toEqual(Array(PARALLEL / 2).fill(200));
        const stamps = new Set([
          ...apiReplies.map((reply) => reply.body.resolved_at),
          ...sqlReplies.map((body) => body.resolved_at),
        ]);
        expect(stamps.size).toBe(1);
      } finally {
        await Promise.all(sqlClients.map((sqlClient) => sqlClient.end()));
      }
      await expectClosedOnce(incidentId);
    });
  });

  describe('lock order with submit (no deadlock)', () => {
    it('mark safe waits on the profile before it locks the incident', async () => {
      const { resident, incidentId } = await activeAlert(1);
      // Submit's first step: the profile FOR UPDATE.
      const { holder, release } = await holdProfileLock(resident.id);
      const closing = httpMarkSafe(resident.id, incidentId);
      await waitForLockWaiters(1);
      // Submit's second step: the open incident FOR UPDATE. Mark safe must not hold it yet.
      await holder.query(`set local lock_timeout = '2s'`);
      const { rows } = await holder.query<{ status: string }>(
        `select status from public.incidents
          where resident_id = $1 and status in ('activating', 'active') for update`,
        [resident.id],
      );
      expect(rows).toEqual([{ status: 'active' }]);
      await release();

      expect((await closing).status).toBe(200);
      await expectClosedOnce(incidentId);
    });

    it('for contrast: the SQL function in the same interleaving deadlocks (40P01)', async () => {
      // Documents why the API takes the profile lock first. Dawit decided to leave the SQL alone.
      const { resident, incidentId } = await activeAlert(1);
      const { holder, release } = await holdProfileLock(resident.id);
      const closer = await openTestClient();
      try {
        const closing = markSafeViaSql(closer, resident.id, incidentId).then(
          () => null,
          (error: { code?: string }) => error.code,
        );
        await waitForLockWaiters(1);
        const locking = holder
          .query(
            `select 1 from public.incidents
              where resident_id = $1 and status in ('activating', 'active') for update`,
            [resident.id],
          )
          .then(
            () => null,
            (error: { code?: string }) => error.code,
          );
        const codes = await Promise.all([closing, locking]);
        expect(codes).toContain('40P01');
      } finally {
        await holder.query('rollback').catch(() => undefined);
        await release().catch(() => undefined);
        await closer.end();
      }
    });

    /**
     * One round: an open alert, then mark safe and a new submit fired together. Either the submit ran
     * first (re-notified the open alert, which the close then closed) or the close ran first (the
     * submit opened a new alert). Never an error, never two open alerts.
     */
    async function raceRound(submitVia: 'api' | 'sql', sqlClient: Client) {
      const { resident, incidentId } = await activeAlert(2);
      const [closed, submitted]: [{ status: number }, { ok: boolean; body: Body }] =
        await Promise.all([
          httpMarkSafe(resident.id, incidentId),
          submitVia === 'api'
            ? httpSubmit(resident.id, 'fire').then((reply) => ({
                ok: reply.status === 200 || reply.status === 201,
                status: reply.status,
                body: reply.body,
              }))
            : submitAlertViaSql(sqlClient, resident.id, 'fire').then(
                (body) => ({ ok: true, status: 0, body }),
                (error: { code?: string }) => ({
                  ok: false,
                  status: 0,
                  body: { sqlstate: error.code } satisfies Body,
                }),
              ),
        ]);
      expect(closed.status).toBe(200);
      // On failure, shows the reply (a deadlock surfaces as 500 internal:error, or SQLSTATE 40P01).
      expect(submitted.ok ? 'ok' : JSON.stringify(submitted.body)).toBe('ok');
      await expectClosedOnce(incidentId);
      const outcome = submitted.body.submit_outcome;
      if (outcome === 'renotified') {
        expect(submitted.body.id).toBe(incidentId);
        expect(await eventCount(incidentId, 'renotified')).toBe(1);
      } else {
        expect(outcome).toBe('created');
        expect(submitted.body.id).not.toBe(incidentId);
      }
      const open = await countRows(
        client,
        `select count(*)::int as n from public.incidents
          where resident_id = $1 and status in ('activating', 'active')`,
        [resident.id],
      );
      expect(open).toBe(outcome === 'created' ? 1 : 0);
      return outcome as string;
    }

    it.each(['api', 'sql'] as const)(
      `mark safe racing a %s submit, ${RACE_ROUNDS} rounds: no deadlock, a correct end state`,
      async (submitVia) => {
        const sqlClient = await openTestClient();
        const outcomes: string[] = [];
        try {
          for (let round = 0; round < RACE_ROUNDS; round++) {
            outcomes.push(await raceRound(submitVia, sqlClient));
          }
        } finally {
          await sqlClient.end();
        }
        expect(outcomes).toHaveLength(RACE_ROUNDS);
      },
      120_000,
    );

    it('mark safe racing a submit queued on the profile: both orders, no deadlock', async () => {
      // Force the dangerous interleaving every time: the submit holds nothing yet, the close queues
      // behind a held profile lock, then the submit queues too; release and let them run.
      for (let round = 0; round < 10; round++) {
        const { resident, incidentId } = await activeAlert(1);
        const lock = await holdProfileLock(resident.id);
        const closing = httpMarkSafe(resident.id, incidentId);
        await waitForLockWaiters(1);
        const submitting = httpSubmit(resident.id, 'fire');
        await waitForLockWaiters(2);
        await lock.release();
        const [closed, submitted] = await Promise.all([closing, submitting]);
        expect(closed.status).toBe(200);
        expect([200, 201]).toContain(submitted.status);
        await expectClosedOnce(incidentId);
      }
    });
  });

  describe('interchangeable with the SQL function', () => {
    const comparable = (body: Body) => {
      const copy: Body = { ...body };
      for (const key of [
        'id',
        'resident_id',
        'circle_id',
        'activated_at',
        'sent_at',
        'resolved_at',
        'location_sharing_ended_at',
      ]) {
        copy[key] = copy[key] === null ? null : 'set';
      }
      return copy;
    };

    const rowsOf = async (incidentId: string) => {
      const { rows: incident } = await client.query<Body>(
        `select status, resolved_reason, auto_closed, emergency_type, share_payload,
                resolved_at = location_sharing_ended_at as same_stamp,
                resolved_at >= activated_at as after_start
           from public.incidents where id = $1`,
        [incidentId],
      );
      const { rows: events } = await client.query<Body>(
        `select e.event_type, e.actor_id = i.resident_id as by_resident,
                e.detail - 'recipient_ids' as detail,
                jsonb_array_length(e.detail->'recipient_ids') as recipients,
                e.occurred_at = i.resolved_at as at_close
           from public.incident_events e join public.incidents i on i.id = e.incident_id
          where e.incident_id = $1
            and e.event_type not in ('alert_sent', 'location_sharing_started')
          order by e.event_type`,
        [incidentId],
      );
      return { incident, events };
    };

    it('same rows, events and response whichever side closes', async () => {
      const [a, b] = [await activeAlert(3), await activeAlert(3)];
      const api = await markSafe(app, a.resident.id, a.incidentId);
      const sql = await markSafeViaSql(client, b.resident.id, b.incidentId);

      expect(comparable(api.json<Body>())).toEqual(comparable(sql));
      expect(Object.keys(api.json<Body>())).toEqual(Object.keys(sql));
      expect(await rowsOf(a.incidentId)).toEqual(await rowsOf(b.incidentId));
      expect((await closureDetail(a.incidentId))?.recipient_ids).toEqual(
        a.memberUsers.map((user) => user.id).sort(),
      );
      expect((await closureDetail(b.incidentId))?.recipient_ids).toEqual(
        b.memberUsers.map((user) => user.id).sort(),
      );
    });

    it('closed by the API: the SQL retry is a no-op returning the same body', async () => {
      const { resident, incidentId } = await activeAlert(2);
      const api = await markSafe(app, resident.id, incidentId);
      const before = await snapshot(incidentId);
      const sql = await callSqlAs<Body>(client, resident.id, 'public.mark_incident_safe($1)', [
        incidentId,
      ]);
      expect(JSON.stringify(sql)).toBe(api.body);
      expect(await snapshot(incidentId)).toEqual(before);
    });

    it('errors match: not_found and not_open', async () => {
      const legacy = await legacyIncident('cancelled');
      const outsider = await createUser(client);
      const outcome = async (userId: string, id: string) => {
        const api = await markSafe(app, userId, id);
        const sql = await callSqlAs(client, userId, 'public.mark_incident_safe($1)', [id]).then(
          () => 'ok',
          (error: { message: string }) => error.message,
        );
        return { api: errorOf(api).code, sql };
      };
      expect(await outcome(outsider.id, legacy.incidentId)).toEqual({
        api: 'mark_incident_safe:not_found',
        sql: 'mark_incident_safe:not_found',
      });
      expect(await outcome(legacy.resident.id, legacy.incidentId)).toEqual({
        api: 'mark_incident_safe:not_open',
        sql: 'mark_incident_safe:not_open',
      });
    });
  });

  it('close then submit: a new incident is created', async () => {
    const { resident, incidentId } = await activeAlert(1);
    await markSafe(app, resident.id, incidentId);
    const next = await submitAlert(app, resident.id, 'other');
    expect(next.statusCode).toBe(201);
    expect(next.json<Body>()).toMatchObject({ submit_outcome: 'created', status: 'active' });
    expect(next.json<Body>().id).not.toBe(incidentId);
  });

  it(`AC8: p99 under 2 s locally with 5 members (${LATENCY_SAMPLES} closes)`, async () => {
    const alerts = [];
    for (let i = 0; i < LATENCY_SAMPLES; i++) alerts.push(await activeAlert(5));
    const durations: number[] = [];
    for (const { resident, incidentId } of alerts) {
      const started = performance.now();
      const reply = await httpMarkSafe(resident.id, incidentId);
      durations.push(performance.now() - started);
      expect(reply.status).toBe(200);
    }
    durations.sort((x, y) => x - y);
    const p99 = durations[Math.ceil(durations.length * 0.99) - 1];
    expect(p99).toBeLessThan(2_000);
  }, 300_000);
});
