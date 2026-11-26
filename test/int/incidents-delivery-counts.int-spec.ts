import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Client } from 'pg';

import { AuditService } from '../../src/modules/audit';
import {
  INCIDENT_POST_COMMIT_HOOKS,
  type IncidentDeliveryCountsEvent,
} from '../../src/modules/incidents/incident-post-commit';
import { IncidentDeliveriesRepository } from '../../src/modules/incidents/incident-deliveries.repository';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { leaveCircle, removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  inviteMember,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import {
  acknowledgeIncident,
  countRows,
  getDeliveryCounts,
  markSafe,
  submitAlert,
} from '../support/incident-api';

/**
 * `GET /v1/incidents/{id}/delivery-counts` and `POST /v1/incidents/{id}/acknowledge` (API-100-20)
 * : who sees the counts (incident.countsView, rule 54), the acknowledge check order, idempotency,
 * audit and the post-commit hook, races on separate connections (no 40P01), the query plan and p99
 * of the 2 s counts poll.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof getDeliveryCounts>>;

const RACE_ROUNDS = 25;
const POLL_SAMPLES = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hookCalls: IncidentDeliveryCountsEvent[] = [];
let hookBehaviour: (event: IncidentDeliveryCountsEvent) => void | Promise<void>;

describe('delivery counts and acknowledge (API-100-20)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app } = await createTestApp({}, (builder) =>
      withTestConfig({ DATABASE_POOL_MAX: '20' })(builder)
        .overrideProvider(INCIDENT_POST_COMMIT_HOOKS)
        .useValue([
          {
            afterDeliveryCounts: (event: IncidentDeliveryCountsEvent) => {
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

  const errorOf = (reply: Reply) => reply.json<{ error: { code: string; details: Body } }>().error;

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    members: UserFixture[];
    memberRows: MemberFixture[];
    incidentId: string;
  }

  /** A resident with `count` active members and an alert opened through the API. */
  async function scene(count = 2): Promise<Scene> {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const members: UserFixture[] = [];
    const memberRows: MemberFixture[] = [];
    for (let i = 0; i < count; i++) {
      const user = await createUser(client);
      memberRows.push(await addActiveMember(client, circle, user));
      members.push(user);
    }
    const reply = await submitAlert(app, resident.id, 'medical');
    expect(reply.statusCode).toBe(201);
    return { resident, circle, members, memberRows, incidentId: reply.json<Body>().id as string };
  }

  /** A member who joined one minute after the incident started, with a stray delivery row. */
  async function lateJoinerWithStrayRow(s: Scene): Promise<UserFixture> {
    const joiner = await createUser(client);
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                 invite_consumed_at, activated_at)
       values ($1, 'member', 'active', 'Joiner', $2, now() + interval '1 minute',
               now() + interval '1 minute')`,
      [s.circle.id, joiner.id],
    );
    await client.query(
      `insert into public.incident_deliveries (incident_id, member_id, member_user_id)
       select $1, m.id, $2 from public.safety_circle_members m
        where m.circle_id = $3 and m.user_id = $2`,
      [s.incidentId, joiner.id, s.circle.id],
    );
    return joiner;
  }

  const deliveryRow = async (incidentId: string, userId: string) =>
    (
      await client.query<{ acknowledged_at: string | null; delivered_at: string }>(
        `select acknowledged_at::text, delivered_at::text from public.incident_deliveries
          where incident_id = $1 and member_user_id = $2`,
        [incidentId, userId],
      )
    ).rows[0];

  const ackAudits = (incidentId: string) =>
    countRows(
      client,
      `select count(*)::int as n from public.audit_log
        where target_id = $1 and action = 'incident.acknowledged'`,
      [incidentId],
    );

  async function httpAck(userId: string, incidentId: string) {
    const response = await fetch(`${baseUrl}/v1/incidents/${incidentId}/acknowledge`, {
      method: 'POST',
      headers: await authHeader(userId),
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  async function httpCounts(userId: string, incidentId: string) {
    const response = await fetch(`${baseUrl}/v1/incidents/${incidentId}/delivery-counts`, {
      headers: await authHeader(userId),
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  async function httpPost(path: string, userId: string, key?: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...(await authHeader(userId)), ...(key ? { 'idempotency-key': key } : {}) },
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  async function httpSubmit(userId: string) {
    const response = await fetch(`${baseUrl}/v1/incidents`, {
      method: 'POST',
      headers: {
        ...(await authHeader(userId)),
        'idempotency-key': randomUUID(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ emergency_type: 'fire' }),
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  describe('AC1: GET /v1/incidents/{id}/delivery-counts', () => {
    it('no token: 401 incident_delivery_counts:not_authenticated', async () => {
      const reply = await app.inject({
        method: 'GET',
        url: '/v1/incidents/00000000-0000-4000-8000-000000000000/delivery-counts',
      });
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('incident_delivery_counts:not_authenticated');
    });

    it('an invalid {id} is 422 validation:invalid_request on field id', async () => {
      const user = await createUser(client);
      const reply = await getDeliveryCounts(app, user.id, 'not-a-uuid');
      expect(reply.statusCode).toBe(422);
      expect(errorOf(reply)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'id' },
      });
    });

    it('resident and inside-window member: exactly the 4 keys, the same body', async () => {
      const s = await scene(2);
      const asResident = await getDeliveryCounts(app, s.resident.id, s.incidentId);
      const asMember = await getDeliveryCounts(app, s.members[0].id, s.incidentId);
      expect(asResident.statusCode).toBe(200);
      expect(asResident.json()).toEqual({
        incident_id: s.incidentId,
        delivered_count: 2,
        acknowledged_count: 0,
        status: 'active',
      });
      expect(Object.keys(asResident.json<Body>()).sort()).toEqual([
        'acknowledged_count',
        'delivered_count',
        'incident_id',
        'status',
      ]);
      expect(asMember.body).toBe(asResident.body);
    });

    it('resident sees any status; a member sees active only', async () => {
      const s = await scene(1);
      expect((await markSafe(app, s.resident.id, s.incidentId)).statusCode).toBe(200);
      const resident = await getDeliveryCounts(app, s.resident.id, s.incidentId);
      expect(resident.json()).toMatchObject({ status: 'resolved', delivered_count: 1 });
      const member = await getDeliveryCounts(app, s.members[0].id, s.incidentId);
      expect(member.statusCode).toBe(404);
      expect(errorOf(member).code).toBe('incident_delivery_counts:not_found');

      const legacy = await createUser(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into public.incidents (resident_id, status, emergency_type, cancelled_at)
         values ($1, 'cancelled', 'unspecified', now()) returning id`,
        [legacy.id],
      );
      expect((await getDeliveryCounts(app, legacy.id, rows[0].id)).json()).toMatchObject({
        status: 'cancelled',
        delivered_count: 0,
      });
    });

    it('hidden existence: every denied caller gets the body of an unknown id', async () => {
      const s = await scene(1);
      const joiner = await lateJoinerWithStrayRow(s);
      const outsider = await createUser(client);
      const pending = await createUser(client);
      await inviteMember(client, s.circle, { claimedBy: pending });
      const unknown = await getDeliveryCounts(
        app,
        outsider.id,
        '00000000-0000-4000-8000-000000000000',
      );
      expect(unknown.statusCode).toBe(404);
      for (const caller of [joiner, outsider, pending]) {
        const reply = await getDeliveryCounts(app, caller.id, s.incidentId);
        expect({ status: reply.statusCode, body: reply.body }).toEqual({
          status: 404,
          body: unknown.body,
        });
      }
      // Removed (D44: the row ends as `removed`): nothing any more.
      expect(
        (await removeMember(app, s.resident.id, s.circle.id, s.memberRows[0].id)).statusCode,
      ).toBe(200);
      const removed = await getDeliveryCounts(app, s.members[0].id, s.incidentId);
      expect(removed.body).toBe(unknown.body);
    });

    it('the 2 s poll fits the default authenticated rate limit (60 polls in a row: all 200)', async () => {
      const s = await scene(1);
      for (let i = 0; i < 60; i++) {
        expect((await getDeliveryCounts(app, s.resident.id, s.incidentId)).statusCode).toBe(200);
      }
    });
  });

  describe('AC2, AC3, AC4: POST /v1/incidents/{id}/acknowledge', () => {
    it('no token: 401 acknowledge_incident:not_authenticated', async () => {
      const reply = await app.inject({
        method: 'POST',
        url: '/v1/incidents/00000000-0000-4000-8000-000000000000/acknowledge',
      });
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('acknowledge_incident:not_authenticated');
    });

    it('first ack: acknowledged_at = now(), counts, one audit row with counts only, the hook', async () => {
      const s = await scene(2);
      const reply = await acknowledgeIncident(app, s.members[0].id, s.incidentId);
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual({
        incident_id: s.incidentId,
        delivered_count: 2,
        acknowledged_count: 1,
        status: 'active',
      });
      expect((await deliveryRow(s.incidentId, s.members[0].id)).acknowledged_at).not.toBeNull();
      expect((await deliveryRow(s.incidentId, s.members[1].id)).acknowledged_at).toBeNull();
      const { rows } = await client.query<Body>(
        `select actor_user_id::text, target_type, detail from public.audit_log
          where target_id = $1 and action = 'incident.acknowledged'`,
        [s.incidentId],
      );
      expect(rows).toEqual([
        {
          actor_user_id: s.members[0].id,
          target_type: 'incident',
          detail: { delivered_count: 2, acknowledged_count: 1 },
        },
      ]);
      const deadline = Date.now() + 5_000;
      while (hookCalls.length < 1 && Date.now() < deadline) await sleep(5);
      expect(hookCalls).toEqual([
        {
          incident_id: s.incidentId,
          resident_id: s.resident.id,
          circle_id: s.circle.id,
          delivered_count: 2,
          acknowledged_count: 1,
        },
      ]);
    });

    it('a repeat writes nothing: same acknowledged_at, no second audit row, no hook', async () => {
      const s = await scene(1);
      await acknowledgeIncident(app, s.members[0].id, s.incidentId);
      const first = await deliveryRow(s.incidentId, s.members[0].id);
      await sleep(20);
      hookCalls.length = 0;
      const again = await acknowledgeIncident(app, s.members[0].id, s.incidentId);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ acknowledged_count: 1 });
      expect(await deliveryRow(s.incidentId, s.members[0].id)).toEqual(first);
      expect(await ackAudits(s.incidentId)).toBe(1);
      await sleep(50);
      expect(hookCalls).toEqual([]);
    });

    it('not_found: unknown, resident, outsider, pending, late joiner with a stray row, removed, left', async () => {
      const s = await scene(3);
      const joiner = await lateJoinerWithStrayRow(s);
      const outsider = await createUser(client);
      const pending = await createUser(client);
      await inviteMember(client, s.circle, { claimedBy: pending });
      expect(
        (await removeMember(app, s.resident.id, s.circle.id, s.memberRows[0].id)).statusCode,
      ).toBe(200);
      expect((await leaveCircle(app, s.members[1].id, s.circle.id)).statusCode).toBe(200);
      const unknown = await acknowledgeIncident(
        app,
        outsider.id,
        '00000000-0000-4000-8000-0000000000aa',
      );
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).code).toBe('acknowledge_incident:not_found');
      for (const caller of [s.resident, outsider, pending, joiner, s.members[0], s.members[1]]) {
        const reply = await acknowledgeIncident(app, caller.id, s.incidentId);
        expect({ status: reply.statusCode, body: reply.body }).toEqual({
          status: 404,
          body: unknown.body,
        });
      }
      expect((await deliveryRow(s.incidentId, joiner.id)).acknowledged_at).toBeNull();
      expect(await ackAudits(s.incidentId)).toBe(0);
    });

    it('not_open after close; not_found wins over not_open', async () => {
      const s = await scene(1);
      const joiner = await lateJoinerWithStrayRow(s);
      expect((await markSafe(app, s.resident.id, s.incidentId)).statusCode).toBe(200);
      const member = await acknowledgeIncident(app, s.members[0].id, s.incidentId);
      expect(member.statusCode).toBe(409);
      expect(errorOf(member).code).toBe('acknowledge_incident:not_open');
      const late = await acknowledgeIncident(app, joiner.id, s.incidentId);
      expect(errorOf(late).code).toBe('acknowledge_incident:not_found');
      expect((await deliveryRow(s.incidentId, s.members[0].id)).acknowledged_at).toBeNull();
    });

    it('legacy statuses inside the window are not_open', async () => {
      const s = await scene(1);
      await client.query(
        `update public.incidents set status = 'activating', sent_at = null where id = $1`,
        [s.incidentId],
      );
      const api = await acknowledgeIncident(app, s.members[0].id, s.incidentId);
      expect(errorOf(api).code).toBe('acknowledge_incident:not_open');
    });

    it('a failure inside the transaction rolls back the ack and the audit, and runs no hook', async () => {
      const s = await scene(1);
      const audit = app.get(AuditService);
      const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('boom'));
      const reply = await acknowledgeIncident(app, s.members[0].id, s.incidentId);
      spy.mockRestore();
      expect(reply.statusCode).toBe(500);
      expect(errorOf(reply).code).toBe('internal:error');
      expect((await deliveryRow(s.incidentId, s.members[0].id)).acknowledged_at).toBeNull();
      await sleep(50);
      expect(hookCalls).toEqual([]);
    });
  });

  describe('races on separate connections (zero 40P01)', () => {
    const isDeadlock = (x: unknown) => JSON.stringify(x).includes('40P01');

    it(`ack racing mark safe, ${RACE_ROUNDS} rounds`, async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(2);
        const member = s.members[round % 2];
        const [acked, closed] = await Promise.all([
          httpAck(member.id, s.incidentId).then((r) =>
            r.status === 200
              ? { ok: true, body: r.body }
              : {
                  ok: false,
                  code: (r.body.error as { code: string }).code,
                  sqlState: String(r.status),
                },
          ),
          httpPost(`/v1/incidents/${s.incidentId}/mark-safe`, s.resident.id, randomUUID()),
        ]);
        expect(isDeadlock(acked) || isDeadlock(closed)).toBe(false);
        expect(closed.status).toBe(200);
        const row = await deliveryRow(s.incidentId, member.id);
        if (acked.ok) {
          // Read the incident before the close committed: acknowledged.
          expect(row.acknowledged_at).not.toBeNull();
        } else {
          expect(acked.code).toBe('acknowledge_incident:not_open');
          expect(row.acknowledged_at).toBeNull();
        }
        const status = await countRows(
          client,
          `select count(*)::int as n from public.incidents where id = $1 and status = 'resolved'`,
          [s.incidentId],
        );
        expect(status).toBe(1);
      }
    }, 120_000);

    it.each(['renotify', 'submit (re-notify)'] as const)(
      `ack racing %s, ${RACE_ROUNDS} rounds: both succeed`,
      async (renotifyVia) => {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const s = await scene(2);
          const member = s.members[round % 2];
          const [acked, renotified] = await Promise.all([
            httpAck(member.id, s.incidentId),
            renotifyVia === 'renotify'
              ? httpPost(`/v1/incidents/${s.incidentId}/renotify`, s.resident.id)
              : httpSubmit(s.resident.id),
          ]);
          expect(isDeadlock(acked) || isDeadlock(renotified)).toBe(false);
          expect(acked.status).toBe(200);
          expect(renotified.status).toBe(200);
          expect((await deliveryRow(s.incidentId, member.id)).acknowledged_at).not.toBeNull();
          expect(await ackAudits(s.incidentId)).toBe(1);
        }
      },
      120_000,
    );

    it('D71: ack key-shares the incident before its delivery row: it waits for a FOR UPDATE holder, then completes', async () => {
      // The responder_acknowledged insert key-shares the incident (its foreign key), so ack takes
      // that lock first (profile → incident → delivery, the order of submit, re-notify and mark
      // safe): while a writer holds the incident it waits WITHOUT holding the delivery row.
      const s = await scene(1);
      const holder = await openTestClient();
      let acking: Promise<{ status: number; body: Body }> | undefined;
      try {
        await holder.query('begin');
        await holder.query('select 1 from public.incidents where id = $1 for update', [
          s.incidentId,
        ]);
        await holder.query('select 1 from public.profiles where id = $1 for update', [
          s.resident.id,
        ]);
        acking = httpAck(s.members[0].id, s.incidentId);
        await waitForLockWaiters(client, 1);
        // The waiting ack holds no delivery row: the holder can still lock it at once.
        await holder.query(`set local lock_timeout = '2s'`);
        await holder.query(
          `select 1 from public.incident_deliveries
            where incident_id = $1 and member_user_id = $2 for update`,
          [s.incidentId, s.members[0].id],
        );
      } finally {
        await holder.query('rollback');
        await holder.end();
      }
      const reply = await acking;
      expect(reply.status).toBe(200);
      expect((await deliveryRow(s.incidentId, s.members[0].id)).acknowledged_at).not.toBeNull();
    });

    it('forced interleaving: renotify waits on a held delivery row, ack queues too; both finish', async () => {
      for (let round = 0; round < 5; round++) {
        const s = await scene(1);
        const holder = await openTestClient();
        await holder.query('begin');
        await holder.query(
          `select 1 from public.incident_deliveries
            where incident_id = $1 and member_user_id = $2 for update`,
          [s.incidentId, s.members[0].id],
        );
        // Re-notify locks profile (key share) and incident, then waits on the delivery row.
        const renotifying = httpPost(`/v1/incidents/${s.incidentId}/renotify`, s.resident.id);
        await waitForLockWaiters(client, 1);
        const acking = httpAck(s.members[0].id, s.incidentId);
        await waitForLockWaiters(client, 2);
        await holder.query('commit');
        await holder.end();
        const [renotified, acked] = await Promise.all([renotifying, acking]);
        expect(renotified.status).toBe(200);
        expect(acked.status).toBe(200);
      }
    });

    it('member removed while acknowledging: either acked then removed, or not_found; never an error', async () => {
      const outcomes = new Set<string>();
      {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const s = await scene(1);
          const [acked, removed] = await Promise.all([
            httpAck(s.members[0].id, s.incidentId),
            removeMember(app, s.resident.id, s.circle.id, s.memberRows[0].id),
          ]);
          expect(removed.statusCode).toBe(200);
          if (acked.status === 200) outcomes.add('acked');
          else {
            expect(acked.status).toBe(404);
            expect((acked.body.error as { code: string }).code).toBe(
              'acknowledge_incident:not_found',
            );
            outcomes.add('not_found');
          }
          // Either way the delivery row went with the membership (D44: deleted by the remove).
          expect(await deliveryRow(s.incidentId, s.members[0].id)).toBeUndefined();
        }
      }
      expect(outcomes.size).toBeGreaterThan(0);
    }, 120_000);

    it('counts read during a close: active counts or the not_found of a closed incident', async () => {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const s = await scene(1);
        const [counts, closed] = await Promise.all([
          httpCounts(s.members[0].id, s.incidentId),
          httpPost(`/v1/incidents/${s.incidentId}/mark-safe`, s.resident.id, randomUUID()),
        ]);
        expect(closed.status).toBe(200);
        if (counts.status === 200) expect(counts.body.status).toBe('active');
        else
          expect(counts.body.error).toMatchObject({ code: 'incident_delivery_counts:not_found' });
      }
    }, 120_000);
  });

  describe('the 2 s poll is cheap', () => {
    beforeAll(async () => {
      // Realistic volume around the measured incident (load fixtures stay in this container).
      await client.query(
        `with users as (
           insert into public.users (id, email)
           select gen_random_uuid(), 'load-' || gen_random_uuid() || '@example.test'
             from generate_series(1, 400)
           returning id),
         profiles as (
           insert into public.profiles (id, full_name, date_of_birth)
           select id, 'Load User', date '1990-01-01' from users returning id),
         circles as (
           insert into public.safety_circles (owner_id, name)
           select id, 'Load Circle' from profiles returning id, owner_id),
         owners as (
           insert into public.safety_circle_members (circle_id, role, status, display_name, user_id)
           select id, 'owner', 'active', 'Load User', owner_id from circles returning circle_id, id),
         incidents as (
           insert into public.incidents (resident_id, circle_id, status, emergency_type, activated_at,
                                         sent_at, resolved_at, resolved_reason)
           select c.owner_id, c.id, 'resolved', 'fire', now() - make_interval(hours => g),
                  now() - make_interval(hours => g), now(), 'safe'
             from circles c cross join generate_series(1, 10) g
           returning id, circle_id)
         insert into public.incident_deliveries (incident_id, member_id, member_user_id)
         select i.id, o.id, gen_random_uuid()
           from incidents i join owners o on o.circle_id = i.circle_id
           cross join generate_series(1, 5)`,
      );
      await client.query('analyze');
    });

    it('the counts statement uses indexes only (no sequential scan)', async () => {
      const s = await scene(5);
      const repository = new IncidentDeliveriesRepository();
      for (const caller of [s.resident.id, s.members[0].id]) {
        const query = new PgDialect().sqlToQuery(
          repository.visibleCountsQuery(s.incidentId, caller),
        );
        const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
          `explain (format json) ${query.sql}`,
          query.params,
        );
        const plan = JSON.stringify(rows[0]['QUERY PLAN']);
        expect(plan).not.toContain('Seq Scan');
        expect(plan).toContain('incidents_pkey');
        expect(plan).toContain('incident_deliveries_incident_id_idx');
        if (caller !== s.resident.id)
          expect(plan).toMatch(
            /"Index Name":"safety_circle_members_(circle_user_uidx|user_id_idx|circle_id_idx)"/,
          );
      }
    });

    it(`p99 of ${POLL_SAMPLES} counts polls (resident and member) is under 100 ms`, async () => {
      const s = await scene(5);
      const timings: number[] = [];
      for (let i = 0; i < POLL_SAMPLES; i++) {
        const caller = i % 2 === 0 ? s.resident.id : s.members[i % 5].id;
        const started = performance.now();
        const reply = await httpCounts(caller, s.incidentId);
        timings.push(performance.now() - started);
        expect(reply.status).toBe(200);
      }
      timings.sort((x, y) => x - y);
      const p99 = timings[Math.ceil(timings.length * 0.99) - 1];
      const p50 = timings[Math.floor(timings.length * 0.5)];
      process.stdout.write(
        `delivery-counts poll: p50 ${p50.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms\n`,
      );
      expect(p99).toBeLessThan(100);
    }, 120_000);
  });
});

/** Waits until `count` backends of this database are blocked on a lock. */
async function waitForLockWaiters(client: Client, count: number): Promise<void> {
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
