import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp } from '../../src/testing/test-app';
import { removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, inviteMember } from '../support/fixtures';
import {
  acknowledgeIncident,
  attachLocation,
  getDeliveryCounts,
  getIncidentDetails,
  markSafe,
  renotifyAlert,
  setIncidentNotes,
  submitAlert,
} from '../support/incident-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * Phase 4 gate (API-100-43 AC1, AC2): realtime parity with today's Supabase Realtime (spec §9) over a
 * whole incident, on two API instances. A member inside the window receives location, notes and
 * the close; the resident receives the counts; a member who joined after the alert started, a
 * pending invitee, a removed member (after the removal) and an outsider receive nothing. And the
 * reconnect contract: nothing is replayed after a reconnect, rooms are not restored, REST has the
 * current state.
 */
type Body = Record<string, unknown>;

const fix = () => ({
  location_source: 'current',
  location_lat: 13.45 + Math.random() / 100,
  location_lng: -16.58 + Math.random() / 100,
  location_accuracy_m: 8,
  location_captured_at: new Date().toISOString(),
});

describe('Phase 4 gate: realtime privacy and the reconnect contract (API-100-43)', () => {
  let appA: NestFastifyApplication;
  let appB: NestFastifyApplication;
  let urlA: string;
  let urlB: string;
  let client: Client;
  const open: TestSocket[] = [];

  async function connect(url: string, userId: string) {
    const socket = await connectSocket(url, userId);
    open.push(socket);
    return socket;
  }

  beforeAll(async () => {
    ({ app: appA } = await createTestApp());
    ({ app: appB } = await createTestApp());
    await appA.listen(0, '127.0.0.1');
    await appB.listen(0, '127.0.0.1');
    urlA = await appA.getUrl();
    urlB = await appB.getUrl();
    client = await openTestClient();
    await eventually(async () => {
      await appA.get(RealtimeGateway).ping();
      await appB.get(RealtimeGateway).ping();
    });
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client.end();
    await appA.close();
    await appB.close();
  });

  it('only the resident and members inside the window receive anything of an incident (AC2)', async () => {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const inside = await createUser(client);
    const removed = await createUser(client);
    await addActiveMember(client, circle, inside);
    const removedRow = await addActiveMember(client, circle, removed);
    const pending = await createUser(client);
    await inviteMember(client, circle, { claimedBy: pending });
    const outsider = await createUser(client);

    const submitted = await submitAlert(appA, resident.id, 'burglary');
    expect(submitted.statusCode).toBe(201);
    const id = submitted.json<Body>().id as string;
    // Joined the circle after the alert started (rule 54).
    const preJoin = await createUser(client);
    await addActiveMember(client, circle, preJoin);

    const r = await connect(urlA, resident.id);
    const m = await connect(urlB, inside.id);
    const x = await connect(urlA, removed.id);
    const sockets = {
      preJoin: await connect(urlB, preJoin.id),
      pending: await connect(urlA, pending.id),
      outsider: await connect(urlB, outsider.id),
    };
    await sleep(300);
    for (const socket of [r, m, x]) await expect(socket.join(id)).resolves.toEqual({ ok: true });
    for (const socket of Object.values(sockets)) {
      await expect(socket.join(id)).resolves.toEqual({
        ok: false,
        error: { code: 'get_incident_details:not_found' },
      });
    }
    // The same people get 404 from REST details.
    for (const user of [preJoin, pending, outsider]) {
      expect((await getIncidentDetails(appA, user.id, id)).statusCode).toBe(404);
    }

    // While still a member, the soon-removed member gets the first location.
    expect((await attachLocation(appB, resident.id, id, fix())).statusCode).toBe(200);
    await m.next('incident.location');
    await x.next('incident.location');
    expect((await removeMember(appA, resident.id, circle.id, removedRow.id)).statusCode).toBe(200);
    await sleep(150);
    const removedBefore = x.received.length;

    expect((await attachLocation(appA, resident.id, id, fix())).statusCode).toBe(200);
    expect(
      (await setIncidentNotes(appB, resident.id, id, { incident_notes: 'Back door' })).statusCode,
    ).toBe(200);
    expect((await renotifyAlert(appA, resident.id, id)).statusCode).toBe(200);
    expect((await acknowledgeIncident(appB, inside.id, id)).statusCode).toBe(200);
    expect((await markSafe(appB, resident.id, id)).statusCode).toBe(200);

    // The member inside the window: location, notes, resolved (and the rest).
    await expect(m.next<Body>('incident.location')).resolves.toMatchObject({ incident_id: id });
    await expect(m.next<Body>('incident.notes')).resolves.toMatchObject({
      incident_notes: 'Back door',
    });
    await expect(m.next<Body>('incident.resolved')).resolves.toMatchObject({
      incident_id: id,
      status: 'resolved',
      resolved_reason: 'safe',
    });
    // The resident: the counts, ending with the acknowledge and the close.
    const counts = (await getDeliveryCounts(appA, resident.id, id)).json<Body>();
    await eventually(() =>
      expect(r.of<Body>('incident.delivery_counts').at(-1)).toMatchObject(counts),
    );
    expect(counts).toMatchObject({ acknowledged_count: 1, status: 'resolved' });
    await expect(r.next<Body>('incident.resolved')).resolves.toMatchObject({ incident_id: id });
    await sleep(300);

    // Nobody outside the window received anything at all; members never got counts.
    for (const socket of Object.values(sockets)) expect(socket.received).toEqual([]);
    expect(x.received.length).toBe(removedBefore);
    expect(m.of('incident.delivery_counts')).toEqual([]);
  });

  it('reconnect contract: no replay, rooms are not restored, REST has the state (AC1)', async () => {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const member = await createUser(client);
    await addActiveMember(client, circle, member);
    const id = (await submitAlert(appA, resident.id, 'medical')).json<Body>().id as string;
    await sleep(300);

    const first = await connect(urlA, member.id);
    await expect(first.join(id)).resolves.toEqual({ ok: true });
    first.close();
    // While the member is offline: a location and a note.
    const offlineFix = fix();
    expect((await attachLocation(appB, resident.id, id, offlineFix)).statusCode).toBe(200);
    expect(
      (await setIncidentNotes(appB, resident.id, id, { incident_notes: 'While offline' }))
        .statusCode,
    ).toBe(200);
    await sleep(300);

    const again = await connect(urlB, member.id);
    await sleep(300);
    // Nothing is replayed, and the new socket is in no incident room until it joins again.
    expect(again.received).toEqual([]);
    expect((await attachLocation(appA, resident.id, id, fix())).statusCode).toBe(200);
    await sleep(300);
    expect(again.received).toEqual([]);

    // The contract: re-fetch over REST, then join again.
    const details = (await getIncidentDetails(appA, member.id, id)).json<Body>();
    expect(details.incident_notes).toBe('While offline');
    await expect(again.join(id)).resolves.toEqual({ ok: true });
    expect((await attachLocation(appB, resident.id, id, fix())).statusCode).toBe(200);
    await expect(again.next<Body>('incident.location')).resolves.toMatchObject({ incident_id: id });
  });
});
