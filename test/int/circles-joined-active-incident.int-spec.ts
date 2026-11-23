import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { leaveCircle, listJoinedCircles, removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  getIncidentDetails,
  getOpenIncident,
  markSafe,
  submitAlert,
} from '../support/incident-api';

/**
 * SCRUM-81 (D45): `GET /v1/me/joined-circles` gives each circle `active_incident_id`: the circle's
 * newest `active` incident the caller may open (`incident.memberView`: an alert received while a
 * member, rule 54; or, on the caller's own `owner` row, `incident.resident`: their own alert), else
 * null. Additive: every other key is as before.
 */
type Body = Record<string, unknown>;

describe('joined circles: active_incident_id (SCRUM-81, D45)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
      }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  const joined = async (user: UserFixture) => {
    const reply = await listJoinedCircles(app, user.id);
    expect(reply.statusCode).toBe(200);
    return reply.json<Body[]>();
  };
  const entryFor = async (user: UserFixture, circleId: string) =>
    (await joined(user)).find((e) => e.circle_id === circleId);

  const twoCircles = async () => {
    const rita = await createUser(client, { fullName: 'Rita Owner' });
    const ritaCircle = await createCircle(client, rita);
    const omar = await createUser(client, { fullName: 'Omar Owner' });
    const omarCircle = await createCircle(client, omar);
    const milo = await createUser(client, { fullName: 'Milo Member' });
    const miloCircle = await createCircle(client, milo);
    await addActiveMember(client, ritaCircle, milo);
    await addActiveMember(client, omarCircle, milo);
    return { rita, ritaCircle, omar, omarCircle, milo, miloCircle };
  };

  it('no incident: null on every row (member and owner rows)', async () => {
    const { milo, ritaCircle, omarCircle, miloCircle } = await twoCircles();
    const list = await joined(milo);
    expect(list.map((e) => e.circle_id).sort()).toEqual(
      [ritaCircle.id, omarCircle.id, miloCircle.id].sort(),
    );
    for (const e of list) expect(e.active_incident_id).toBeNull();
  });

  it('an active incident the member received: its id on that circle only; it opens', async () => {
    const { rita, ritaCircle, omarCircle, milo } = await twoCircles();
    const incident = (await submitAlert(app, rita.id, 'medical')).json<Body>().id as string;
    expect((await entryFor(milo, ritaCircle.id))?.active_incident_id).toBe(incident);
    expect((await entryFor(milo, omarCircle.id))?.active_incident_id).toBeNull();
    expect((await getIncidentDetails(app, milo.id, incident)).statusCode).toBe(200);
    // The other keys are unchanged.
    expect(await entryFor(milo, ritaCircle.id)).toMatchObject({
      role: 'member',
      status: 'active',
      owner_name: 'Rita Owner',
      active_member_count: 1,
    });
  });

  it('the owner row carries the owner’s own active alert (they are its resident)', async () => {
    const { rita, ritaCircle } = await twoCircles();
    expect((await entryFor(rita, ritaCircle.id))?.active_incident_id).toBeNull();
    const incident = (await submitAlert(app, rita.id, 'fire')).json<Body>().id as string;
    const own = await entryFor(rita, ritaCircle.id);
    expect(own).toMatchObject({ role: 'owner', active_incident_id: incident });
    expect((await getOpenIncident(app, rita.id)).json<Body>()).toMatchObject({
      open_incident: { id: incident },
    });
  });

  it('resolved: back to null', async () => {
    const { rita, ritaCircle, milo } = await twoCircles();
    const incident = (await submitAlert(app, rita.id, 'medical')).json<Body>().id as string;
    expect((await entryFor(milo, ritaCircle.id))?.active_incident_id).toBe(incident);
    expect((await markSafe(app, rita.id, incident)).statusCode).toBe(200);
    expect((await entryFor(milo, ritaCircle.id))?.active_incident_id).toBeNull();
    expect((await entryFor(rita, ritaCircle.id))?.active_incident_id).toBeNull();
  });

  it('an incident that started before the caller joined (not a recipient): null', async () => {
    const { rita, ritaCircle, milo } = await twoCircles();
    const incident = (await submitAlert(app, rita.id, 'medical')).json<Body>().id as string;
    const late = await createUser(client, { fullName: 'Late Joiner' });
    await addActiveMember(client, ritaCircle, late);
    const entry = await entryFor(late, ritaCircle.id);
    expect(entry).toBeDefined();
    expect(entry?.active_incident_id).toBeNull();
    expect((await getIncidentDetails(app, late.id, incident)).statusCode).toBe(404);
    // Milo, a member before it started, still gets it.
    expect((await entryFor(milo, ritaCircle.id))?.active_incident_id).toBe(incident);
  });

  it.each(['removed', 'left'] as const)(
    'membership %s during the incident: the circle is no longer listed',
    async (how) => {
      const { rita, ritaCircle, omarCircle, milo } = await twoCircles();
      await submitAlert(app, rita.id, 'medical');
      const before = await entryFor(milo, ritaCircle.id);
      expect(before?.active_incident_id).not.toBeNull();
      const reply =
        how === 'removed'
          ? await removeMember(app, rita.id, ritaCircle.id, before?.member_id as string)
          : await leaveCircle(app, milo.id, ritaCircle.id);
      expect(reply.statusCode).toBe(200);
      const list = await joined(milo);
      expect(list.map((e) => e.circle_id)).not.toContain(ritaCircle.id);
      expect(list.map((e) => e.circle_id)).toContain(omarCircle.id);
    },
  );

  it('two circles with alerts at once: each row shows its own incident', async () => {
    const { rita, ritaCircle, omar, omarCircle, milo } = await twoCircles();
    const a = (await submitAlert(app, rita.id, 'medical')).json<Body>().id as string;
    const b = (await submitAlert(app, omar.id, 'fire')).json<Body>().id as string;
    expect((await entryFor(milo, ritaCircle.id))?.active_incident_id).toBe(a);
    expect((await entryFor(milo, omarCircle.id))?.active_incident_id).toBe(b);
  });
});
