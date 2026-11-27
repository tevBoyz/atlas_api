import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  getOpenIncident,
  listIncidentUpdates,
  markSafe,
  sendIncidentUpdate,
  submitAlert,
} from '../support/incident-api';

/**
 * SCRUM-69 / SCRUM-70 server side (no API change): the app queues an offline SOS and offline status
 * updates and retries each with its own Idempotency-Key until the server confirms (Dawit's approval
 * 2026-11-25, D74 note). These tests confirm the retries are safe: a retry after a lost response
 * (client timeout, reconnect) or a duplicate sent in parallel makes exactly one alert / one update and
 * the replay answers the original result; what a replay does once the alert is resolved; queued
 * updates sent in order arrive in order; and the SOS request is minimal (only the emergency type).
 */
type Body = Record<string, unknown>;
const PARALLEL = 6;

describe('SCRUM-69/70 offline retries are idempotent (no API change)', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
        DATABASE_POOL_MAX: String(PARALLEL * 2),
      }),
    ));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  async function residentWithCircle(members = 1) {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const memberUsers: UserFixture[] = [];
    for (let i = 0; i < members; i++) {
      const user = await createUser(client);
      await addActiveMember(client, circle, user);
      memberUsers.push(user);
    }
    return { resident, memberUsers };
  }

  /** A real HTTP request on its own socket (parallel duplicates). */
  async function http(path: string, userId: string, key: string, body: Body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...(await authHeader(userId)),
        'idempotency-key': key,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      replayed: response.headers.get('idempotent-replayed'),
      body: (await response.json()) as Body,
    };
  }

  const count = async (sql: string, params: unknown[]) =>
    (await client.query<{ n: number }>(sql, params)).rows[0].n;
  const incidentCount = (residentId: string) =>
    count('select count(*)::int as n from public.incidents where resident_id = $1', [residentId]);
  const eventCount = (incidentId: unknown, type: string) =>
    count(
      'select count(*)::int as n from public.incident_events where incident_id = $1 and event_type = $2',
      [incidentId, type],
    );
  const outboxCount = (incidentId: unknown) =>
    count('select count(*)::int as n from public.notification_outbox where aggregate_id = $1', [
      incidentId,
    ]);
  const deliveryCount = (incidentId: unknown) =>
    count('select count(*)::int as n from public.incident_deliveries where incident_id = $1', [
      incidentId,
    ]);

  describe('SOS submit (POST /v1/incidents)', () => {
    it('the request is minimal: only emergency_type (location follows separately)', async () => {
      const { resident } = await residentWithCircle();
      const res = await submitAlert(app, resident.id, 'medical');
      expect(res.statusCode).toBe(201);
      expect(res.json<Body>()).toMatchObject({ submit_outcome: 'created', location_source: null });
      const doc = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json<{
        components: { schemas: Record<string, { properties: Body; required?: string[] }> };
      }>();
      const request = doc.components.schemas.SubmitEmergencyAlertRequest;
      // Stage 2 [B6] / [B9]: plus the optional place keys (never coordinates).
      expect(Object.keys(request.properties).sort()).toEqual([
        'country_code',
        'emergency_type',
        'place_name',
      ]);
      expect(request.required).toEqual(['emergency_type']);
    });

    it('a retry after a lost response (same key, same body): the original 201 replayed; one alert', async () => {
      const { resident } = await residentWithCircle(2);
      const key = randomUUID();
      // The first attempt reached the server and committed; the phone never saw the answer.
      const lost = await submitAlert(app, resident.id, 'fire', key);
      expect(lost.statusCode).toBe(201);
      const id = lost.json<Body>().id;
      const before = {
        sent: await eventCount(id, 'alert_sent'),
        outbox: await outboxCount(id),
        deliveries: await deliveryCount(id),
      };

      for (let i = 0; i < 3; i++) {
        const retry = await submitAlert(app, resident.id, 'fire', key);
        expect(retry.statusCode).toBe(201);
        expect(retry.headers['idempotent-replayed']).toBe('true');
        expect(retry.json()).toEqual(lost.json());
      }
      expect(await incidentCount(resident.id)).toBe(1);
      expect(await eventCount(id, 'alert_sent')).toBe(1);
      expect(await eventCount(id, 'renotified')).toBe(0);
      expect({
        sent: await eventCount(id, 'alert_sent'),
        outbox: await outboxCount(id),
        deliveries: await deliveryCount(id),
      }).toEqual(before);
    });

    it(`${PARALLEL} duplicates in parallel (same key): one alert, one created answer; the rest replay or say in_progress`, async () => {
      const { resident } = await residentWithCircle();
      const key = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          http('/v1/incidents', resident.id, key, { emergency_type: 'medical' }),
        ),
      );
      const fresh = replies.filter((r) => r.status === 201 && r.replayed === null);
      expect(fresh).toHaveLength(1);
      for (const reply of replies) {
        if (reply === fresh[0]) continue;
        if (reply.status === 409) {
          expect(reply.body).toMatchObject({ error: { code: 'idempotency:in_progress' } });
        } else {
          expect(reply).toMatchObject({ status: 201, replayed: 'true', body: fresh[0].body });
        }
      }
      expect(await incidentCount(resident.id)).toBe(1);
      expect(await eventCount(fresh[0].body.id, 'alert_sent')).toBe(1);
      // The retry the app makes after a 409 (Retry-After: 1) gets the original answer.
      const after = await http('/v1/incidents', resident.id, key, { emergency_type: 'medical' });
      expect(after).toMatchObject({ status: 201, replayed: 'true', body: fresh[0].body });
    });

    it('a replay after the alert was resolved: the original 201 (as sent then); nothing reopened or created', async () => {
      const { resident } = await residentWithCircle();
      const key = randomUUID();
      const first = await submitAlert(app, resident.id, 'fire', key);
      const id = first.json<Body>().id as string;
      expect((await markSafe(app, resident.id, id)).statusCode).toBe(200);

      const replay = await submitAlert(app, resident.id, 'fire', key);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      expect(replay.json<Body>()).toMatchObject({ status: 'active', submit_outcome: 'created' });
      const { rows } = await client.query<Body>(
        'select status, resolved_reason from public.incidents where id = $1',
        [id],
      );
      expect(rows[0]).toEqual({ status: 'resolved', resolved_reason: 'safe' });
      expect(await incidentCount(resident.id)).toBe(1);
      // The live read tells the truth: no open alert.
      expect((await getOpenIncident(app, resident.id)).json()).toEqual({ open_incident: null });
      // A queued SOS that never reached the server (its first attempt now, own key) is a new alert.
      const queued = await submitAlert(app, resident.id, 'fire');
      expect(queued.statusCode).toBe(201);
      expect(queued.json<Body>()).toMatchObject({ submit_outcome: 'created' });
      expect(queued.json<Body>().id).not.toBe(id);
      expect(await incidentCount(resident.id)).toBe(2);
    });

    it('a retried SOS with a new key while one is open re-notifies the same alert (never a second one)', async () => {
      const { resident } = await residentWithCircle();
      const first = await submitAlert(app, resident.id, 'fire');
      const second = await submitAlert(app, resident.id, 'fire');
      expect(second.statusCode).toBe(200);
      expect(second.json<Body>()).toMatchObject({
        id: first.json<Body>().id,
        submit_outcome: 'renotified',
      });
      expect(await incidentCount(resident.id)).toBe(1);
    });
  });

  describe('status updates (POST /v1/incidents/{id}/updates)', () => {
    async function activeAlert() {
      const s = await residentWithCircle(1);
      const submitted = await submitAlert(app, s.resident.id, 'medical');
      return { ...s, incidentId: submitted.json<Body>().id as string };
    }

    it('a retry after a lost response: the original 201 replayed; one update, one push row', async () => {
      const { resident, incidentId } = await activeAlert();
      const key = randomUUID();
      const lost = await sendIncidentUpdate(
        app,
        resident.id,
        incidentId,
        { preset: 'help_is_here' },
        key,
      );
      expect(lost.statusCode).toBe(201);
      for (let i = 0; i < 3; i++) {
        const retry = await sendIncidentUpdate(
          app,
          resident.id,
          incidentId,
          { preset: 'help_is_here' },
          key,
        );
        expect(retry.statusCode).toBe(201);
        expect(retry.headers['idempotent-replayed']).toBe('true');
        expect(retry.json()).toEqual(lost.json());
      }
      expect(await eventCount(incidentId, 'status_update')).toBe(1);
      expect(
        await count(
          `select count(*)::int as n from public.notification_outbox
            where aggregate_id = $1 and topic = 'incident.status_update'`,
          [incidentId],
        ),
      ).toBe(1);
    });

    it(`${PARALLEL} duplicates in parallel (same key): one update`, async () => {
      const { resident, incidentId } = await activeAlert();
      const key = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          http(`/v1/incidents/${incidentId}/updates`, resident.id, key, { text: 'On my way out' }),
        ),
      );
      const fresh = replies.filter((r) => r.status === 201 && r.replayed === null);
      expect(fresh).toHaveLength(1);
      for (const reply of replies) {
        if (reply === fresh[0]) continue;
        expect([201, 409]).toContain(reply.status);
        if (reply.status === 201) expect(reply.body).toEqual(fresh[0].body);
      }
      expect(await eventCount(incidentId, 'status_update')).toBe(1);
    });

    it('queued updates sent in order on reconnect (own keys) arrive in order, once each, even when re-sent', async () => {
      const { resident, memberUsers, incidentId } = await activeAlert();
      const queue = [
        { key: randomUUID(), body: { preset: 'situation_worsening' } },
        { key: randomUUID(), body: { text: 'Smoke in the hallway' } },
        { key: randomUUID(), body: { preset: 'help_is_here' } },
      ];
      for (const item of queue) {
        expect(
          (await sendIncidentUpdate(app, resident.id, incidentId, item.body, item.key)).statusCode,
        ).toBe(201);
      }
      // The connection dropped again before the app saw the answers: the whole queue is re-sent.
      for (const item of queue) {
        const again = await sendIncidentUpdate(app, resident.id, incidentId, item.body, item.key);
        expect(again.headers['idempotent-replayed']).toBe('true');
      }
      const list = (await listIncidentUpdates(app, memberUsers[0].id, incidentId)).json<Body[]>();
      // Newest first.
      expect(list.map((u) => u.preset ?? u.text)).toEqual([
        'help_is_here',
        'Smoke in the hallway',
        'situation_worsening',
      ]);
    });

    it('after mark safe: a replay answers the original 201; a first send (new key) is 409 not_open', async () => {
      const { resident, incidentId } = await activeAlert();
      const key = randomUUID();
      const first = await sendIncidentUpdate(
        app,
        resident.id,
        incidentId,
        { text: 'Still here' },
        key,
      );
      expect((await markSafe(app, resident.id, incidentId)).statusCode).toBe(200);
      const replay = await sendIncidentUpdate(
        app,
        resident.id,
        incidentId,
        { text: 'Still here' },
        key,
      );
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      const lateKey = randomUUID();
      const late = await sendIncidentUpdate(
        app,
        resident.id,
        incidentId,
        { text: 'Too late' },
        lateKey,
      );
      expect(late.statusCode).toBe(409);
      expect(late.json<{ error: { code: string } }>().error.code).toBe('incident_updates:not_open');
      // A refused send is stored too: its retry gets the same 409, still nothing written.
      const lateRetry = await sendIncidentUpdate(
        app,
        resident.id,
        incidentId,
        { text: 'Too late' },
        lateKey,
      );
      expect(lateRetry.statusCode).toBe(409);
      expect(lateRetry.headers['idempotent-replayed']).toBe('true');
      expect(lateRetry.json()).toEqual(late.json());
      expect(await eventCount(incidentId, 'status_update')).toBe(1);
    });
  });
});
