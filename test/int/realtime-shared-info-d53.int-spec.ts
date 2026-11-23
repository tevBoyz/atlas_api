import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp } from '../../src/testing/test-app';
import { removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import { getIncidentDetails, markSafe, submitAlert } from '../support/incident-api';
import {
  addMedicalItem,
  deleteMedicalItem,
  patchSharingFlags,
  putEmergencyInfo,
  emergencyInfoBody,
} from '../support/profile-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * SCRUM-21 AC4 (D53): when the resident changes their shared info during an active incident, the
 * live view is rewritten in the same transaction and, after the commit, `incident.shared_info_updated
 * {incident_id, share_payload, updated_at, occurred_at}` goes to the incident room (the resident and
 * the members inside the window who joined it), on every instance. Nobody else gets it; a write that
 * changes nothing shared sends nothing; the activation snapshot never changes.
 */
type Body = Record<string, unknown>;
const UTC_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const EVENT = 'incident.shared_info_updated';

describe('incident.shared_info_updated (SCRUM-21, D53)', () => {
  let appA: NestFastifyApplication;
  let appB: NestFastifyApplication;
  let urlA: string;
  let urlB: string;
  let client: Client;
  const open: TestSocket[] = [];

  async function connect(url: string, user: UserFixture) {
    const socket = await connectSocket(url, user.id);
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

  async function scene() {
    const rita = await createUser(client, { fullName: 'Rita Resident' });
    const circle = await createCircle(client, rita);
    const milo = await createUser(client);
    const nina = await createUser(client);
    const miloRow = await addActiveMember(client, circle, milo);
    await addActiveMember(client, circle, nina);
    const outsider = await createUser(client);
    await addMedicalItem(appA, rita.id, 'allergies', { text: 'Peanuts' });
    await addMedicalItem(appA, rita.id, 'medical-conditions', { text: 'Asthma' });
    await patchSharingFlags(appA, rita.id, {
      share_allergies: true,
      share_medical_conditions: true,
      share_blood_type: true,
    });
    const submitted = await submitAlert(appA, rita.id, 'medical');
    expect(submitted.statusCode).toBe(201);
    const id = submitted.json<Body>().id as string;
    await sleep(200);
    return { rita, circle, milo, nina, miloRow, outsider, id };
  }

  it('reaches the joined member on another instance and the resident; not a member who did not join, not an outsider', async () => {
    const { rita, milo, nina, outsider, id } = await scene();
    const miloSocket = await connect(urlA, milo);
    const ritaSocket = await connect(urlA, rita);
    const ninaSocket = await connect(urlB, nina);
    const outsiderSocket = await connect(urlB, outsider);
    await expect(miloSocket.join(id)).resolves.toEqual({ ok: true });
    await expect(ritaSocket.join(id)).resolves.toEqual({ ok: true });
    await expect(outsiderSocket.join(id)).resolves.toMatchObject({ ok: false });

    // Rita adds an allergy through instance B.
    expect((await addMedicalItem(appB, rita.id, 'allergies', { text: 'Latex' })).statusCode).toBe(
      200,
    );
    const event = await miloSocket.next<Body>(EVENT);
    expect(Object.keys(event)).toEqual([
      'incident_id',
      'share_payload',
      'updated_at',
      'occurred_at',
    ]);
    expect(event).toEqual({
      incident_id: id,
      share_payload: {
        blood_type: 'Unknown',
        allergies: ['Peanuts', 'Latex'],
        medical_conditions: ['Asthma'],
      },
      updated_at: expect.stringMatching(UTC_TEXT) as unknown,
      occurred_at: expect.stringMatching(UTC_TEXT) as unknown,
    });
    await expect(ritaSocket.next<Body>(EVENT)).resolves.toEqual(event);
    // The member read says the same; the activation snapshot is unchanged.
    const details = (await getIncidentDetails(appA, milo.id, id)).json<Body>();
    expect(details.share_payload).toEqual(event.share_payload);
    expect(details.share_payload_updated_at).toBe(event.updated_at);
    expect(details.share_payload_at_activation).toEqual({
      blood_type: 'Unknown',
      allergies: ['Peanuts'],
      medical_conditions: ['Asthma'],
    });

    // A share flag turned off mid-incident: that item is gone from the live view at once.
    await patchSharingFlags(appB, rita.id, { share_medical_conditions: false });
    const off = await miloSocket.next<Body>(EVENT);
    expect(off.share_payload).toEqual({ blood_type: 'Unknown', allergies: ['Peanuts', 'Latex'] });
    expect(new Date(off.updated_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(event.updated_at as string).getTime(),
    );

    // Not shared any more: editing conditions changes nothing members see, so nothing is sent.
    const conditionId = (
      (await addMedicalItem(appB, rita.id, 'medical-conditions', { text: 'Diabetes' })).json<Body>()
        .medical_condition_items as { id: string }[]
    )[1].id;
    await deleteMedicalItem(appB, rita.id, 'medical-conditions', conditionId);
    await sleep(400);
    expect(miloSocket.of(EVENT)).toHaveLength(2);
    expect(ninaSocket.of(EVENT)).toEqual([]);
    expect(outsiderSocket.of(EVENT)).toEqual([]);
    expect(JSON.stringify(outsiderSocket.received)).not.toMatch(/Peanuts|Latex|Asthma/);
    await markSafe(appA, rita.id, id);
  });

  it('emergency-info edits (blood type, a newly shared field) are sent; after mark safe nothing is', async () => {
    const { rita, milo, id } = await scene();
    const miloSocket = await connect(urlB, milo);
    await expect(miloSocket.join(id)).resolves.toEqual({ ok: true });
    await putEmergencyInfo(
      appA,
      rita.id,
      emergencyInfoBody({
        blood_type: 'O+',
        share_blood_type: true,
        share_allergies: true,
        share_medical_conditions: true,
        share_emergency_contact_phone: true,
      }),
    );
    const event = await miloSocket.next<Body>(EVENT);
    expect(event.share_payload).toEqual({
      emergency_contact_phone: '+12015550188',
      blood_type: 'O+',
      allergies: ['Peanuts'],
      medical_conditions: ['Asthma'],
    });
    expect((await markSafe(appA, rita.id, id)).statusCode).toBe(200);
    await addMedicalItem(appA, rita.id, 'allergies', { text: 'Bees' });
    await sleep(400);
    expect(miloSocket.of(EVENT)).toHaveLength(1);
    const { rows } = await client.query<{ live: Body }>(
      'select live_share_payload as live from public.incidents where id = $1',
      [id],
    );
    expect(rows[0].live).toEqual(event.share_payload);
  });

  it('a removed member is out of the room and gets nothing', async () => {
    const { rita, circle, milo, nina, miloRow, id } = await scene();
    const miloSocket = await connect(urlA, milo);
    const ninaSocket = await connect(urlB, nina);
    await expect(miloSocket.join(id)).resolves.toEqual({ ok: true });
    await expect(ninaSocket.join(id)).resolves.toEqual({ ok: true });
    expect((await removeMember(appA, rita.id, circle.id, miloRow.id)).statusCode).toBe(200);
    await sleep(200);
    await addMedicalItem(appB, rita.id, 'allergies', { text: 'Latex' });
    await expect(ninaSocket.next<Body>(EVENT)).resolves.toMatchObject({ incident_id: id });
    await sleep(300);
    expect(miloSocket.of(EVENT)).toEqual([]);
    await markSafe(appA, rita.id, id);
  });
});
