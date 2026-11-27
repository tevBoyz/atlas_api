import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { leaveCircle, removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  acknowledgeIncident,
  getIncidentDetails,
  getIncidentEvents,
  listResponderIncidents,
  markSafe,
  renotifyAlert,
  submitAlert,
} from '../support/incident-api';
import { connectSocket, type TestSocket } from '../support/realtime-client';

/**
 * Gaps_Adressed Stage 2 [B13] (SCRUM-64 AC3): remove / leave no longer delete `incident_deliveries`;
 * an ended member READS (details, events, responders, Activity circle category, the responder
 * incident list) a past incident of that circle they had a delivery row for created before
 * `ended_at`, once the incident is resolved or closed. While it is active: not available. Never
 * live: no room join, no acknowledge / response, no recipient of a re-notify or the closing notice,
 * no count, nothing after `ended_at`. Re-joined: new alerts count from the new membership only.
 */
type Body = Record<string, unknown>;
const CONFIG = {
  RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
  RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
};

describe('Stage 2 [B13] ended members keep past alerts read-only', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let url: string;
  const open: TestSocket[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    client = await openTestClient();
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const get = async (userId: string, path: string) =>
    app.inject({ method: 'GET', url: path, headers: await authHeader(userId) });

  async function activityIncidents(userId: string): Promise<string[]> {
    const reply = await get(userId, '/v1/me/activity?category=circle&limit=50');
    expect(reply.statusCode).toBe(200);
    const entries = reply.json<{ entries: { incident: Body }[] }>().entries;
    return [...new Set(entries.map((e) => e.incident.id as string))];
  }

  const listed = async (userId: string) =>
    (await listResponderIncidents(app, userId)).json<Body[]>().map((i) => i.id as string);

  async function readsOf(user: UserFixture, incidentId: string): Promise<number[]> {
    return [
      (await getIncidentDetails(app, user.id, incidentId)).statusCode,
      (await getIncidentEvents(app, user.id, incidentId)).statusCode,
      (await get(user.id, `/v1/incidents/${incidentId}/responders`)).statusCode,
    ];
  }

  async function scene() {
    const rita = await createUser(client, { fullName: 'Rita Resident' });
    const circle = await createCircle(client, rita);
    const ben = await createUser(client, { fullName: 'Ben Member' });
    const cara = await createUser(client, { fullName: 'Cara Member' });
    const benRow = await addActiveMember(client, circle, ben);
    await addActiveMember(client, circle, cara);
    return { rita, circle, ben, benRow, cara };
  }

  const counts = async (incidentId: string) =>
    (
      await client.query<{ total: number; live: number }>(
        `select count(*)::int as total,
                count(*) filter (where m.status = 'active')::int as live
           from public.incident_deliveries d
           join public.safety_circle_members m on m.id = d.member_id
          where d.incident_id = $1`,
        [incidentId],
      )
    ).rows[0];

  const outboxRecipients = async (incidentId: string, topic: string) =>
    (
      await client.query<{ ids: string[] }>(
        `select payload->'recipient_user_ids' as ids from public.notification_outbox
          where aggregate_id = $1 and topic = $2 order by created_at desc, id desc limit 1`,
        [incidentId, topic],
      )
    ).rows[0]?.ids;

  it('removed during an active alert: kept row, nothing live; readable once resolved; later alerts never', async () => {
    const { rita, circle, ben, benRow, cara } = await scene();
    const first = await submitAlert(app, rita.id, 'medical');
    expect(first.statusCode).toBe(201);
    const a1 = first.json<Body>().id as string;
    expect(await readsOf(ben, a1)).toEqual([200, 200, 200]);

    expect((await removeMember(app, rita.id, circle.id, benRow.id)).statusCode).toBe(200);
    // The delivery row stays (history) but no longer counts.
    expect(await counts(a1)).toEqual({ total: 2, live: 1 });
    // While the alert is active: not available, no acknowledge, no room join.
    expect(await readsOf(ben, a1)).toEqual([404, 404, 404]);
    expect(await listed(ben.id)).not.toContain(a1);
    expect(await activityIncidents(ben.id)).not.toContain(a1);
    expect((await acknowledgeIncident(app, ben.id, a1)).statusCode).toBe(404);
    const benSocket = await connectSocket(url, ben.id);
    open.push(benSocket);
    expect((await benSocket.join(a1)).ok).toBe(false);

    // A re-notify reaches Cara only, and counts her only.
    const again = await renotifyAlert(app, rita.id, a1);
    expect(again.statusCode).toBe(200);
    expect(again.json<Body>().delivered_count).toBe(1);
    expect(await outboxRecipients(a1, 'incident.renotified')).toEqual([cara.id]);

    // Mark safe: the closing notice goes to Cara only. Now Ben reads the past alert, read-only.
    const safe = await markSafe(app, rita.id, a1);
    expect(safe.statusCode).toBe(200);
    expect(safe.json<Body>().delivered_count).toBe(1);
    expect(await outboxRecipients(a1, 'incident.resolved')).toEqual([cara.id]);
    expect(await readsOf(ben, a1)).toEqual([200, 200, 200]);
    expect((await getIncidentDetails(app, ben.id, a1)).json<Body>().status).toBe('resolved');
    const responders = (await get(ben.id, `/v1/incidents/${a1}/responders`)).json<Body[]>();
    // Members see other members' ids masked and never the delivery keys; Ben has no live row.
    expect(responders.map((r) => r.display_name)).toEqual(['Cara Member']);
    expect(await listed(ben.id)).toContain(a1);
    expect(await activityIncidents(ben.id)).toContain(a1);
    expect((await acknowledgeIncident(app, ben.id, a1)).statusCode).toBe(404);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${a1}/response`,
      headers: { ...(await authHeader(ben.id)), 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'responding' }),
    });
    expect(response.statusCode).toBe(404);
    expect((await benSocket.join(a1)).ok).toBe(false);

    // An alert after the removal: no row for Ben, never readable, not listed.
    const second = await submitAlert(app, rita.id, 'fire');
    const a2 = second.json<Body>().id as string;
    expect(await counts(a2)).toEqual({ total: 1, live: 1 });
    expect(await markSafe(app, rita.id, a2).then((r) => r.statusCode)).toBe(200);
    expect(await readsOf(ben, a2)).toEqual([404, 404, 404]);
    expect(await listed(ben.id)).not.toContain(a2);
    expect(await activityIncidents(ben.id)).not.toContain(a2);

    // Re-joined (a new active row): a new alert counts from the new membership; the old past alert
    // stays readable; the alert sent while he was out stays hidden.
    // A new invite releases the user from the history row (claim, D41/D44), then a new row.
    await client.query('update public.safety_circle_members set user_id = null where id = $1', [
      benRow.id,
    ]);
    await addActiveMember(client, circle, ben);
    const third = await submitAlert(app, rita.id, 'other');
    const a3 = third.json<Body>().id as string;
    expect(third.json<Body>().delivered_count).toBe(2);
    expect(await readsOf(ben, a3)).toEqual([200, 200, 200]);
    expect(await readsOf(ben, a1)).toEqual([200, 200, 200]);
    expect(await readsOf(ben, a2)).toEqual([404, 404, 404]);
    expect(await markSafe(app, rita.id, a3).then((r) => r.statusCode)).toBe(200);
  });

  it('left after an alert ended: the past alert stays readable; a closed one too', async () => {
    const { rita, circle, ben } = await scene();
    const a1 = (await submitAlert(app, rita.id, 'medical')).json<Body>().id as string;
    expect((await markSafe(app, rita.id, a1)).statusCode).toBe(200);
    await client.query(
      `update public.incidents set status = 'closed', closed_at = now() where id = $1`,
      [a1],
    );
    expect((await leaveCircle(app, ben.id, circle.id)).statusCode).toBe(200);
    expect(await readsOf(ben, a1)).toEqual([200, 200, 200]);
    expect((await getIncidentDetails(app, ben.id, a1)).json<Body>().status).toBe('closed');
    expect(await listed(ben.id)).toContain(a1);
    expect(await activityIncidents(ben.id)).toContain(a1);
  });

  it('a delivery row written after ended_at never opens the history; an outsider never reads', async () => {
    const { rita, circle, ben, benRow } = await scene();
    const outsider = await createUser(client);
    const a1 = (await submitAlert(app, rita.id, 'medical')).json<Body>().id as string;
    expect((await removeMember(app, rita.id, circle.id, benRow.id)).statusCode).toBe(200);
    // Crafted: Ben's row dated after his ended_at (it can never be written so, but the rule says
    // "created before ended_at").
    await client.query(
      `update public.incident_deliveries d set delivered_at = m.ended_at + interval '1 second'
         from public.safety_circle_members m
        where m.id = d.member_id and d.incident_id = $1 and d.member_user_id = $2`,
      [a1, ben.id],
    );
    expect((await markSafe(app, rita.id, a1)).statusCode).toBe(200);
    expect(await readsOf(ben, a1)).toEqual([404, 404, 404]);
    expect(await readsOf(outsider, a1)).toEqual([404, 404, 404]);
    expect(await activityIncidents(ben.id)).not.toContain(a1);
  });
});
