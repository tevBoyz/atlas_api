import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AuditService } from '../../src/modules/audit';
import {
  INCIDENT_POST_COMMIT_HOOKS,
  type IncidentSubmittedEvent,
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
import { countRows, submitAlert, submitAlertViaSql } from '../support/incident-api';

/**
 * `POST /v1/incidents` (API-100-15) beyond the SQL script: check order, status codes, re-notify and
 * promote, share payload, audit, post-commit hooks, idempotent replay, and real concurrency on
 * separate database connections. The SQL script's own assertions are in
 * `test/parity/scrum43_submit_emergency_alert.spec.ts`.
 */
type Body = Record<string, unknown>;

const INCIDENT_SEND_KEYS = [
  'acknowledged_count',
  'activated_at',
  'activity_confirmed_at',
  'auto_closed',
  'cancelled_at',
  'circle_id',
  'delivered_count',
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
  'renotified_at',
  'resident_id',
  'resolved_at',
  'resolved_reason',
  'sent_at',
  'share_payload',
  'status',
];
const POSTGRES_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/;
/** Parallel requests in the concurrency tests. */
const PARALLEL = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replaced by each hook test; reset before every test. */
let hookBehaviour: (event: IncidentSubmittedEvent) => void | Promise<void>;
const hookCalls: IncidentSubmittedEvent[] = [];

describe('POST /v1/incidents (API-100-15)', () => {
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
            afterSubmit: (event: IncidentSubmittedEvent) => {
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

  const newResident = () => createUser(client);

  /** A resident with a circle of `members` active members. */
  async function residentWithCircle(members = 1): Promise<{
    resident: UserFixture;
    circle: CircleFixture;
    memberUsers: UserFixture[];
  }> {
    const resident = await newResident();
    const circle = await createCircle(client, resident);
    const memberUsers: UserFixture[] = [];
    for (let i = 0; i < members; i++) {
      const user = await createUser(client);
      await addActiveMember(client, circle, user);
      memberUsers.push(user);
    }
    return { resident, circle, memberUsers };
  }

  const errorCode = (reply: { json: <T>() => T }) =>
    reply.json<{ error: { code: string } }>().error.code;

  const eventCount = (incidentId: unknown, eventType: string) =>
    countRows(
      client,
      `select count(*)::int as n from public.incident_events
        where incident_id = $1 and event_type = $2`,
      [incidentId, eventType],
    );

  const openIncidents = (residentId: string) =>
    countRows(
      client,
      `select count(*)::int as n from public.incidents
        where resident_id = $1 and status in ('activating', 'active')`,
      [residentId],
    );

  const auditRows = async (targetId: unknown) => {
    const { rows } = await client.query<{
      action: string;
      actor_user_id: string;
      actor_session_id: string | null;
      target_type: string;
      request_id: string | null;
      detail: Body;
    }>(
      `select action, actor_user_id, actor_session_id, target_type, request_id, detail
         from public.audit_log where target_id = $1 order by id`,
      [targetId],
    );
    return rows;
  };

  /** Holds the resident's profile row lock until `release` is called. */
  async function holdProfileLock(residentId: string) {
    const holder = await openTestClient();
    await holder.query('begin');
    await holder.query('select 1 from public.profiles where id = $1 for update', [residentId]);
    return {
      release: async () => {
        await holder.query('commit');
        await holder.end();
      },
    };
  }

  /** Waits until `count` other backends of this database are blocked on a lock. */
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

  /** A real HTTP request over its own socket. */
  async function httpSubmit(userId: string, type: string, key: string = randomUUID()) {
    const response = await fetch(`${baseUrl}/v1/incidents`, {
      method: 'POST',
      headers: {
        ...(await authHeader(userId)),
        'idempotency-key': key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ emergency_type: type }),
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  describe('AC1, AC2: request and check order', () => {
    it('no token: 401 before the key and body are looked at', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/incidents', payload: {} });
      expect(res.statusCode).toBe(401);
      expect(errorCode(res)).toBe('submit_emergency_alert:not_authenticated');
    });

    it('a missing Idempotency-Key is 400 idempotency:key_required', async () => {
      const { id } = await newResident();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/incidents',
        headers: await authHeader(id),
        payload: { emergency_type: 'fire' },
      });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('idempotency:key_required');
      expect(await openIncidents(id)).toBe(0);
    });

    it('a key that is not a UUID is 422 idempotency:invalid_key', async () => {
      const { id } = await newResident();
      const res = await submitAlert(app, id, 'fire', 'not-a-uuid');
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('idempotency:invalid_key');
    });

    it.each([
      ['a missing field', {}],
      ['null', { emergency_type: null }],
      ['a number', { emergency_type: 1 }],
      ['surrounding spaces', { emergency_type: ' medical ' }],
      ['upper case', { emergency_type: 'MEDICAL' }],
      ['a body that is an array', ['medical']],
    ])('%s is 422 :invalid_type', async (_label, payload) => {
      const { id } = await newResident();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/incidents',
        headers: {
          ...(await authHeader(id)),
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('submit_emergency_alert:invalid_type');
    });

    it('no body at all is 422 :invalid_type', async () => {
      const { id } = await newResident();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/incidents',
        headers: { ...(await authHeader(id)), 'idempotency-key': randomUUID() },
      });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('submit_emergency_alert:invalid_type');
    });

    it('the type is checked before the profile', async () => {
      const noProfile = await createUser(client, { profile: false });
      const res = await submitAlert(app, noProfile.id, 'unspecified');
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('submit_emergency_alert:invalid_type');
    });

    it('a missing profile is checked before incomplete setup and writes nothing', async () => {
      const noProfile = await createUser(client, { profile: false });
      const res = await submitAlert(app, noProfile.id, 'fire');
      expect(res.statusCode).toBe(404);
      expect(errorCode(res)).toBe('submit_emergency_alert:profile_not_found');
    });

    it.each(['medical', 'domestic_violence', 'fire', 'burglary', 'other'])(
      'accepts %s',
      async (type) => {
        const { id } = await newResident();
        const res = await submitAlert(app, id, type);
        expect(res.statusCode).toBe(201);
        expect(res.json<Body>().emergency_type).toBe(type);
      },
    );
  });

  describe('AC3: re-notify', () => {
    it('refreshes every delivery, keeps acks, type, circle, payload and sent_at', async () => {
      const { resident, circle, memberUsers } = await residentWithCircle(2);
      const created = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      await client.query(
        `update public.incident_deliveries
            set delivered_at = now() - interval '1 minute',
                acknowledged_at = now() - interval '30 seconds'
          where incident_id = $1 and member_user_id = $2`,
        [created.id, memberUsers[0].id],
      );
      await client.query(
        `update public.profiles set blood_type = 'AB-', share_blood_type = true
                           where id = $1`,
        [resident.id],
      );

      const res = await submitAlert(app, resident.id, 'medical');
      const body = res.json<Body>();

      expect(res.statusCode).toBe(200);
      expect(body).toMatchObject({
        id: created.id,
        submit_outcome: 'renotified',
        emergency_type: 'fire',
        circle_id: circle.id,
        sent_at: created.sent_at,
        activated_at: created.activated_at,
        delivered_count: 2,
        acknowledged_count: 1,
      });
      expect(body.share_payload).toEqual(created.share_payload);
      expect(body.renotified_at).toEqual(expect.any(String));

      const { rows } = await client.query<{ fresh: boolean; acked: boolean }>(
        `select d.delivered_at = i.renotified_at as fresh, d.acknowledged_at is not null as acked
           from public.incident_deliveries d join public.incidents i on i.id = d.incident_id
          where d.incident_id = $1 order by d.member_user_id = $2 desc`,
        [created.id, memberUsers[0].id],
      );
      expect(rows).toEqual([
        { fresh: true, acked: true },
        { fresh: true, acked: false },
      ]);
      const { rows: events } = await client.query<{ detail: Body }>(
        `select detail from public.incident_events
          where incident_id = $1 and event_type = 'renotified'`,
        [created.id],
      );
      expect(events).toEqual([{ detail: { recipient_count: 2 } }]);
    });

    it('a member who joined after the incident started gets no delivery row', async () => {
      const { resident, circle } = await residentWithCircle(1);
      const created = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      await addActiveMember(client, circle, await createUser(client));

      const body = (await submitAlert(app, resident.id, 'fire')).json<Body>();

      expect(body.delivered_count).toBe(1);
      const { rows } = await client.query<{ detail: Body }>(
        `select detail from public.incident_events
          where incident_id = $1 and event_type = 'renotified'`,
        [created.id],
      );
      expect(rows[0].detail).toEqual({ recipient_count: 1 });
    });

    it('a resident whose alert was closed gets a new incident', async () => {
      const { resident } = await residentWithCircle(1);
      const closed = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      await client.query(
        `update public.incidents
            set status = 'resolved', resolved_at = now(), resolved_reason = 'safe',
                location_sharing_ended_at = now()
          where id = $1`,
        [closed.id],
      );

      const res = await submitAlert(app, resident.id, 'burglary');

      expect(res.statusCode).toBe(201);
      expect(res.json<Body>().id).not.toBe(closed.id);
      expect(res.json<Body>().submit_outcome).toBe('created');
    });
  });

  describe('AC3: promote a legacy activating row', () => {
    it('becomes active with the given type, keeping activated_at and circle_id', async () => {
      const { resident, circle, memberUsers } = await residentWithCircle(1);
      const { rows } = await client.query<{ id: string; activated_at: string }>(
        `insert into public.incidents (resident_id, circle_id, status, activated_at)
         values ($1, $2, 'activating', now() - interval '5 minutes')
         returning id, to_jsonb(activated_at) #>> '{}' as activated_at`,
        [resident.id, circle.id],
      );

      const res = await submitAlert(app, resident.id, 'burglary');
      const body = res.json<Body>();

      expect(res.statusCode).toBe(201);
      expect(body).toMatchObject({
        id: rows[0].id,
        status: 'active',
        submit_outcome: 'promoted',
        emergency_type: 'burglary',
        circle_id: circle.id,
        cancelled_at: null,
        delivered_count: 1,
      });
      expect(new Date(body.activated_at as string)).toEqual(new Date(rows[0].activated_at));
      expect(body.sent_at).toEqual(expect.any(String));
      expect(body.share_payload).toEqual({});
      expect(await eventCount(rows[0].id, 'alert_sent')).toBe(1);
      expect(await eventCount(rows[0].id, 'location_sharing_started')).toBe(1);
      expect(await auditRows(rows[0].id)).toEqual([
        expect.objectContaining({
          action: 'incident.created',
          detail: { recipient_count: 1, submit_outcome: 'promoted' },
        }),
      ]);
      expect(memberUsers).toHaveLength(1);
    });
  });

  describe('AC4: share payload snapshot', () => {
    it('includes only flagged, non-blank values and matches the SQL helper', async () => {
      const resident = await newResident();
      await client.query(
        `update public.profiles
            set emergency_contact_full_name = '  Ada Contact  ',
                share_emergency_contact_full_name = true,
                emergency_contact_relationship = 'friend',
                share_emergency_contact_relationship = false,
                emergency_contact_phone = '+12015550199',
                share_emergency_contact_phone = true,
                blood_type = 'O+', share_blood_type = true,
                allergies = '   ', share_allergies = true,
                medical_conditions = 'Asthma', share_medical_conditions = false,
                emergency_notes = E'\\tgate code  ', emergency_notes_shareable = true
          where id = $1`,
        [resident.id],
      );
      const { rows } = await client.query<{ expected: Body }>(
        `select public._incident_share_payload(p) as expected
           from public.profiles p where p.id = $1`,
        [resident.id],
      );

      const body = (await submitAlert(app, resident.id, 'medical')).json<Body>();

      expect(body.share_payload).toEqual(rows[0].expected);
      expect(body.share_payload).toEqual({
        emergency_contact_full_name: 'Ada Contact',
        emergency_contact_phone: '+12015550199',
        blood_type: 'O+',
        // btrim removes spaces only: the leading tab stays, as it does in the SQL function.
        emergency_notes: '\tgate code',
      });
    });

    it('is {} (not null) when nothing is shared', async () => {
      const resident = await newResident();
      const body = (await submitAlert(app, resident.id, 'other')).json<Body>();
      expect(body.share_payload).toEqual({});
    });
  });

  describe('AC5: deliveries and events', () => {
    it('active members only, recipient_ids sorted ascending', async () => {
      const { resident, circle, memberUsers } = await residentWithCircle(3);
      await inviteMember(client, circle);
      await inviteMember(client, circle, { claimedBy: await createUser(client) });

      const body = (await submitAlert(app, resident.id, 'fire')).json<Body>();

      const expected = memberUsers.map((user) => user.id).sort();
      const { rows } = await client.query<{ member_user_id: string }>(
        `select member_user_id from public.incident_deliveries
          where incident_id = $1 order by member_user_id`,
        [body.id],
      );
      expect(rows.map((row) => row.member_user_id)).toEqual(expected);
      const { rows: events } = await client.query<{ detail: Body; actor_id: string }>(
        `select detail, actor_id from public.incident_events
          where incident_id = $1 and event_type = 'alert_sent'`,
        [body.id],
      );
      expect(events).toEqual([
        {
          actor_id: resident.id,
          detail: { recipient_count: 3, recipient_ids: expected, emergency_type: 'fire' },
        },
      ]);
    });

    it('never writes membership rows', async () => {
      const { resident, circle } = await residentWithCircle(2);
      const read = () =>
        client.query(
          `select id, status, activated_at, updated_at from public.safety_circle_members
            where circle_id = $1 order by id`,
          [circle.id],
        );
      const before = await read();

      await submitAlert(app, resident.id, 'fire');
      await submitAlert(app, resident.id, 'fire');

      expect((await read()).rows).toEqual(before.rows);
    });
  });

  describe('AC6, AC7: response shape', () => {
    it('is IncidentSend plus submit_outcome, with database timestamps', async () => {
      const { resident } = await residentWithCircle(1);
      const body = (await submitAlert(app, resident.id, 'fire')).json<Body>();

      expect(Object.keys(body).sort()).toEqual([...INCIDENT_SEND_KEYS, 'submit_outcome'].sort());
      expect(body.activated_at).toMatch(POSTGRES_UTC_TIMESTAMP);
      expect(body.sent_at).toBe(body.activated_at);
    });

    it('no circle is success with delivered_count 0', async () => {
      const resident = await newResident();
      const res = await submitAlert(app, resident.id, 'fire');
      expect(res.statusCode).toBe(201);
      expect(res.json<Body>()).toMatchObject({ circle_id: null, delivered_count: 0 });
    });

    it('a circle with no active member is success with delivered_count 0', async () => {
      const { resident, circle } = await residentWithCircle(0);
      await inviteMember(client, circle);
      const res = await submitAlert(app, resident.id, 'fire');
      expect(res.statusCode).toBe(201);
      expect(res.json<Body>()).toMatchObject({ circle_id: circle.id, delivered_count: 0 });
    });
  });

  describe('AC8: audit', () => {
    it('records created and renotified with safe detail only', async () => {
      const { resident } = await residentWithCircle(2);
      const created = (await submitAlert(app, resident.id, 'domestic_violence')).json<Body>();
      await submitAlert(app, resident.id, 'domestic_violence');

      const rows = await auditRows(created.id);

      expect(rows.map((row) => row.action)).toEqual(['incident.created', 'incident.renotified']);
      expect(rows[0]).toMatchObject({
        actor_user_id: resident.id,
        target_type: 'incident',
        detail: { recipient_count: 2, submit_outcome: 'created' },
      });
      expect(rows[1].detail).toEqual({ recipient_count: 2, submit_outcome: 'renotified' });
      expect(rows[0].request_id).toEqual(expect.any(String));
      expect(JSON.stringify(rows)).not.toContain('domestic_violence');
    });

    it('a session id claim that is not a uuid does not fail the alert', async () => {
      const resident = await newResident();
      const res = await submitAlert(app, resident.id, 'fire', randomUUID(), {
        claims: { session_id: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(201);
      const rows = await auditRows(res.json<Body>().id);
      expect(rows[0].actor_session_id).toBeNull();
    });

    it('a failure inside the transaction rolls everything back and hides its detail', async () => {
      const { resident } = await residentWithCircle(1);
      const marker = 'params-sentinel-domestic_violence';
      jest
        .spyOn(app.get(AuditService), 'record')
        .mockRejectedValueOnce(new Error(`Failed query\nparams: ${marker}`));

      const res = await submitAlert(app, resident.id, 'domestic_violence');

      expect(res.statusCode).toBe(500);
      expect(errorCode(res)).toBe('internal:error');
      expect(res.body).not.toContain(marker);
      expect(logs.text).not.toContain(marker);
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.incidents where resident_id = $1`,
          [resident.id],
        ),
      ).toBe(0);
      expect(hookCalls).toEqual([]);
    });
  });

  describe('AC8: post-commit hooks', () => {
    const waitForHook = async (count = 1) => {
      const deadline = Date.now() + 5_000;
      while (hookCalls.length < count && Date.now() < deadline) await sleep(5);
      expect(hookCalls).toHaveLength(count);
    };

    it('run after commit: the incident is visible from another connection', async () => {
      const { resident, circle } = await residentWithCircle(1);
      let visible = -1;
      hookBehaviour = async (event) => {
        visible = await countRows(
          client,
          `select count(*)::int as n from public.incidents where id = $1`,
          [event.incident_id],
        );
      };

      const body = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      await waitForHook();
      for (let i = 0; i < 200 && visible < 0; i++) await sleep(5);

      expect(visible).toBe(1);
      expect(hookCalls[0]).toEqual({
        incident_id: body.id,
        resident_id: resident.id,
        circle_id: circle.id,
        submit_outcome: 'created',
        recipient_count: 1,
      });
    });

    it('also run for a re-notify', async () => {
      const { resident } = await residentWithCircle(2);
      await submitAlert(app, resident.id, 'fire');
      await submitAlert(app, resident.id, 'fire');
      await waitForHook(2);
      expect(hookCalls[1]).toMatchObject({ submit_outcome: 'renotified', recipient_count: 2 });
    });

    it.each([
      [
        'throws',
        () => {
          throw new Error('hook exploded');
        },
      ],
      ['rejects', () => Promise.reject(new Error('hook exploded'))],
    ])('a hook that %s never fails the committed alert', async (_label, behaviour) => {
      const resident = await newResident();
      hookBehaviour = behaviour;

      const res = await submitAlert(app, resident.id, 'fire');

      expect(res.statusCode).toBe(201);
      await waitForHook();
      expect(await openIncidents(resident.id)).toBe(1);
    });

    it('a hook that never finishes does not hold the response', async () => {
      const resident = await newResident();
      hookBehaviour = () => new Promise(() => undefined);
      const res = await submitAlert(app, resident.id, 'fire');
      expect(res.statusCode).toBe(201);
    });

    it('do not run when the request fails its checks', async () => {
      const noProfile = await createUser(client, { profile: false });
      await submitAlert(app, noProfile.id, 'fire');
      await sleep(50);
      expect(hookCalls).toEqual([]);
    });
  });

  describe('idempotent replay', () => {
    it('replays the original 201 and 200, with no second write or hook', async () => {
      const { resident } = await residentWithCircle(1);
      const createKey = randomUUID();
      const renotifyKey = randomUUID();
      const created = await submitAlert(app, resident.id, 'fire', createKey);
      const renotified = await submitAlert(app, resident.id, 'fire', renotifyKey);
      const id = created.json<Body>().id;
      hookCalls.length = 0;

      const replayCreated = await submitAlert(app, resident.id, 'fire', createKey);
      const replayRenotified = await submitAlert(app, resident.id, 'fire', renotifyKey);

      expect(replayCreated.statusCode).toBe(201);
      expect(replayCreated.json()).toEqual(created.json());
      expect(replayCreated.headers['idempotent-replayed']).toBe('true');
      expect(replayRenotified.statusCode).toBe(200);
      expect(replayRenotified.json()).toEqual(renotified.json());
      expect(await eventCount(id, 'renotified')).toBe(1);
      expect(await auditRows(id)).toHaveLength(2);
      await sleep(50);
      expect(hookCalls).toEqual([]);
    });

    it('the same key with another body is 422 idempotency:key_mismatch', async () => {
      const resident = await newResident();
      const key = randomUUID();
      await submitAlert(app, resident.id, 'fire', key);
      const res = await submitAlert(app, resident.id, 'medical', key);
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('idempotency:key_mismatch');
    });

    it('an error response is replayed too', async () => {
      const noProfile = await createUser(client, { profile: false });
      const key = randomUUID();
      const first = await submitAlert(app, noProfile.id, 'fire', key);
      const replay = await submitAlert(app, noProfile.id, 'fire', key);
      expect(first.statusCode).toBe(404);
      expect(replay.statusCode).toBe(404);
      expect(replay.headers['idempotent-replayed']).toBe('true');
    });

    it('the same key while the first request is running is 409 in_progress', async () => {
      const resident = await newResident();
      const key = randomUUID();
      const lock = await holdProfileLock(resident.id);

      const running = httpSubmit(resident.id, 'fire', key);
      await waitForLockWaiters(1);
      const duplicate = await httpSubmit(resident.id, 'fire', key);
      await lock.release();
      const first = await running;

      expect(duplicate.status).toBe(409);
      expect((duplicate.body.error as { code: string }).code).toBe('idempotency:in_progress');
      expect(first.status).toBe(201);
      expect(await openIncidents(resident.id)).toBe(1);
    });
  });

  describe('AC9: concurrency on separate connections', () => {
    it('parallel submits with different keys: one incident, one alert_sent', async () => {
      const { resident, memberUsers } = await residentWithCircle(5);
      const lock = await holdProfileLock(resident.id);

      const requests = Array.from({ length: PARALLEL }, () => httpSubmit(resident.id, 'fire'));
      // Every request is inside its own transaction, on its own connection, before any proceeds.
      await waitForLockWaiters(PARALLEL);
      await lock.release();
      const replies = await Promise.all(requests);

      const statuses = replies.map((reply) => reply.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
      const ids = new Set(replies.map((reply) => reply.body.id));
      expect(ids.size).toBe(1);
      const [id] = [...ids];

      expect(await openIncidents(resident.id)).toBe(1);
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.incident_deliveries where incident_id = $1`,
          [id],
        ),
      ).toBe(memberUsers.length);
      expect(await eventCount(id, 'alert_sent')).toBe(1);
      expect(await eventCount(id, 'location_sharing_started')).toBe(1);
      expect(await eventCount(id, 'renotified')).toBe(PARALLEL - 1);
      const actions = (await auditRows(id)).map((row) => row.action);
      expect(actions.filter((action) => action === 'incident.created')).toHaveLength(1);
      expect(actions.filter((action) => action === 'incident.renotified')).toHaveLength(
        PARALLEL - 1,
      );
    });

    it('API and SQL callers racing each other still open one incident', async () => {
      const { resident, memberUsers } = await residentWithCircle(2);
      const sqlClients = await Promise.all(
        Array.from({ length: PARALLEL / 2 }, () => openTestClient()),
      );
      const lock = await holdProfileLock(resident.id);

      const api = Array.from({ length: PARALLEL / 2 }, () => httpSubmit(resident.id, 'fire'));
      const viaSql = sqlClients.map((sqlClient) =>
        submitAlertViaSql(sqlClient, resident.id, 'fire'),
      );
      await waitForLockWaiters(PARALLEL);
      await lock.release();
      const [apiReplies, sqlReplies] = await Promise.all([Promise.all(api), Promise.all(viaSql)]);
      await Promise.all(sqlClients.map((sqlClient) => sqlClient.end()));

      const outcomes = [
        ...apiReplies.map((reply) => reply.body.submit_outcome),
        ...sqlReplies.map((body) => body.submit_outcome),
      ];
      expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'renotified')).toHaveLength(PARALLEL - 1);
      const ids = new Set([
        ...apiReplies.map((reply) => reply.body.id),
        ...sqlReplies.map((body) => body.id),
      ]);
      expect(ids.size).toBe(1);
      const [id] = [...ids];
      expect(await openIncidents(resident.id)).toBe(1);
      expect(await eventCount(id, 'alert_sent')).toBe(1);
      expect(await eventCount(id, 'renotified')).toBe(PARALLEL - 1);
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.incident_deliveries where incident_id = $1`,
          [id],
        ),
      ).toBe(memberUsers.length);
    });

    /** Closes the incident in an open transaction, as `mark_incident_safe` does. */
    async function closeInOpenTransaction(residentId: string, incidentId: unknown) {
      const closer = await openTestClient();
      await closer.query('begin');
      await closer.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [residentId, JSON.stringify({ sub: residentId, role: 'authenticated' })],
      );
      await closer.query('select public.mark_incident_safe($1)', [incidentId]);
      return closer;
    }

    it('a submit waiting on a closing incident opens a new one once the close commits', async () => {
      const { resident } = await residentWithCircle(1);
      const first = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      const closer = await closeInOpenTransaction(resident.id, first.id);

      const waiting = httpSubmit(resident.id, 'medical');
      await waitForLockWaiters(1);
      await closer.query('commit');
      await closer.end();
      const reply = await waiting;

      expect(reply.status).toBe(201);
      expect(reply.body.submit_outcome).toBe('created');
      expect(reply.body.id).not.toBe(first.id);
      expect(await openIncidents(resident.id)).toBe(1);
    });

    it('the incident row lock: a close holding only that row is seen once it commits', async () => {
      // mark_incident_safe also blocks the profile lock (its events reference the profile), so this
      // close touches the incident row alone: the submit can only be waiting on the incident lock.
      const { resident } = await residentWithCircle(1);
      const first = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      const closer = await openTestClient();
      await closer.query('begin');
      await closer.query(
        `update public.incidents
            set status = 'resolved', resolved_at = now(), resolved_reason = 'safe',
                location_sharing_ended_at = now()
          where id = $1`,
        [first.id],
      );

      const waiting = httpSubmit(resident.id, 'medical');
      await waitForLockWaiters(1);
      await closer.query('commit');
      await closer.end();
      const reply = await waiting;

      expect(reply.status).toBe(201);
      expect(reply.body.submit_outcome).toBe('created');
      expect(reply.body.id).not.toBe(first.id);
      expect(await openIncidents(resident.id)).toBe(1);
    });

    it('a submit waiting on a close that rolls back re-notifies the open incident', async () => {
      const { resident } = await residentWithCircle(1);
      const first = (await submitAlert(app, resident.id, 'fire')).json<Body>();
      const closer = await closeInOpenTransaction(resident.id, first.id);

      const waiting = httpSubmit(resident.id, 'medical');
      await waitForLockWaiters(1);
      await closer.query('rollback');
      await closer.end();
      const reply = await waiting;

      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        id: first.id,
        submit_outcome: 'renotified',
        emergency_type: 'fire',
      });
    });
  });

  describe('interchangeable with the SQL function', () => {
    /** Two residents in the same starting state. */
    async function twins() {
      const build = async () => {
        const { resident, circle, memberUsers } = await residentWithCircle(2);
        await inviteMember(client, circle);
        await client.query(
          `update public.profiles
              set blood_type = 'O+', share_blood_type = true,
                  allergies = 'Peanuts', share_allergies = false,
                  emergency_notes = '  Side door ', emergency_notes_shareable = true
            where id = $1`,
          [resident.id],
        );
        return { resident, circle, memberUsers };
      };
      return { viaApi: await build(), viaSql: await build() };
    }

    /** The rows a submit wrote, without values that differ between two residents. */
    async function writtenRows(incidentId: unknown) {
      const { rows: incidents } = await client.query<Body>(
        `select status, emergency_type, share_payload, location_lat, location_lng,
                location_accuracy_m, location_captured_at, location_source, cancelled_at,
                incident_notes, incident_notes_updated_at, renotified_at is not null as renotified,
                resolved_at, resolved_reason, auto_closed, activity_confirmed_at,
                location_sharing_ended_at, sent_at = activated_at as sent_at_activation,
                updated_at = activated_at as untouched
           from public.incidents where id = $1`,
        [incidentId],
      );
      const { rows: deliveries } = await client.query<Body>(
        `select count(*)::int as total,
                count(acknowledged_at)::int as acknowledged,
                bool_and(delivered_at = i.activated_at) as delivered_at_activation
           from public.incident_deliveries d
           join public.incidents i on i.id = d.incident_id
          where d.incident_id = $1`,
        [incidentId],
      );
      const { rows: events } = await client.query<Body>(
        `select event_type, detail - 'recipient_ids' as detail,
                jsonb_array_length(coalesce(detail->'recipient_ids', '[]'::jsonb)) as recipients,
                actor_id = i.resident_id as by_resident,
                occurred_at = i.activated_at as at_activation
           from public.incident_events e
           join public.incidents i on i.id = e.incident_id
          where e.incident_id = $1
          order by event_type`,
        [incidentId],
      );
      return { incident: incidents[0], deliveries, events };
    }

    /** JSON type of every value: the shape a client parses. */
    const shapeOf = (body: Body) =>
      Object.keys(body).map((key) => {
        const value = body[key];
        return [key, value === null ? 'null' : typeof value];
      });

    it('create: same rows, same response keys, key order and value types', async () => {
      const { viaApi, viaSql } = await twins();

      const apiBody = (await submitAlert(app, viaApi.resident.id, 'medical')).json<Body>();
      const sqlBody = await submitAlertViaSql(client, viaSql.resident.id, 'medical');

      expect(shapeOf(apiBody)).toEqual(shapeOf(sqlBody));
      expect(apiBody.share_payload).toEqual(sqlBody.share_payload);
      expect(apiBody.submit_outcome).toBe(sqlBody.submit_outcome);
      expect(apiBody.activated_at).toMatch(POSTGRES_UTC_TIMESTAMP);
      expect(sqlBody.activated_at).toMatch(POSTGRES_UTC_TIMESTAMP);
      expect(await writtenRows(apiBody.id)).toEqual(await writtenRows(sqlBody.id));
    });

    it('re-notify: same rows and response whichever side created the incident', async () => {
      const { viaApi, viaSql } = await twins();
      const apiCreated = (await submitAlert(app, viaApi.resident.id, 'fire')).json<Body>();
      const sqlCreated = await submitAlertViaSql(client, viaSql.resident.id, 'fire');

      // Crossed over: SQL re-notifies the API's incident, the API re-notifies the SQL's.
      const sqlBody = await submitAlertViaSql(client, viaApi.resident.id, 'medical');
      const reply = await submitAlert(app, viaSql.resident.id, 'medical');
      const apiBody = reply.json<Body>();

      expect(reply.statusCode).toBe(200);
      expect(sqlBody.id).toBe(apiCreated.id);
      expect(apiBody.id).toBe(sqlCreated.id);
      expect(shapeOf(apiBody)).toEqual(shapeOf(sqlBody));
      const normalize = async (id: unknown) => {
        const { incident, events } = await writtenRows(id);
        return { incident: { ...incident, untouched: null }, events };
      };
      expect(await normalize(apiCreated.id)).toEqual(await normalize(sqlCreated.id));
    });

    it('promote: same rows and response from a legacy activating row', async () => {
      const { viaApi, viaSql } = await twins();
      const legacy = (residentId: string, circleId: string) =>
        client.query(
          `insert into public.incidents (resident_id, circle_id, status)
           values ($1, $2, 'activating')`,
          [residentId, circleId],
        );
      await legacy(viaApi.resident.id, viaApi.circle.id);
      await legacy(viaSql.resident.id, viaSql.circle.id);

      const apiBody = (await submitAlert(app, viaApi.resident.id, 'burglary')).json<Body>();
      const sqlBody = await submitAlertViaSql(client, viaSql.resident.id, 'burglary');

      expect(apiBody.submit_outcome).toBe('promoted');
      expect(sqlBody.submit_outcome).toBe('promoted');
      expect(shapeOf(apiBody)).toEqual(shapeOf(sqlBody));
      const normalize = async (id: unknown) => {
        const { incident, deliveries, events } = await writtenRows(id);
        return {
          incident: { ...incident, sent_at_activation: null, untouched: null },
          deliveries,
          events: events.map((event) => ({ ...event, at_activation: null })),
        };
      };
      expect(await normalize(apiBody.id)).toEqual(await normalize(sqlBody.id));
    });
  });

  it('logs neither the emergency type nor shared medical values', async () => {
    const resident = await newResident();
    await client.query(
      `update public.profiles
          set allergies = 'Sentinel-Allergy-Value', share_allergies = true where id = $1`,
      [resident.id],
    );
    const res = await submitAlert(app, resident.id, 'domestic_violence');
    expect(res.statusCode).toBe(201);
    // SCRUM-21 (D52): the list is an array of strings.
    expect(res.json<{ share_payload: Body }>().share_payload.allergies).toEqual([
      'Sentinel-Allergy-Value',
    ]);
    expect(logs.text).not.toContain('Sentinel-Allergy-Value');
    expect(logs.text).not.toContain('domestic_violence');
  });
});
