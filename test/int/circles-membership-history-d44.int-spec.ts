import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  cancelInvite,
  createInviteLink,
  errorOf,
  getCapacity,
  inviteBatch,
  invitePhone,
  leaveCircle,
  listJoinedCircles,
  listMembers,
  listMyInvites,
  lookupInvite,
  previewInvite,
  removeMember,
  resendInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  fakePhone,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import {
  acknowledgeIncident,
  getDeliveryCounts,
  getIncidentDetails,
  getIncidentEvents,
  listResponderIncidents,
  submitAlert,
} from '../support/incident-api';
import { memberRow } from '../support/invite-rows';
import { completeSetup } from '../support/profile-api';

/**
 * D44 (SCRUM-30 remove a member, SCRUM-31 leave a Safety Circle; plan approved by Dawit
 * 2026-11-22): an ended membership is kept as history (`removed` / `left`, `ended_at`), and every
 * reader ignores it: the owner's and the member's member lists, capacity, joined circles, incoming
 * invites, invite lookup / preview / accept by the old token, resend / cancel, incident access
 * (active and history) and the responder list. Rejoining needs a NEW invitation: a new link
 * (the claim releases the history row's `user_id`, D41 extended) or a new phone invite to the same
 * number (the history row gives its phone up).
 */
type Body = Record<string, unknown>;

describe('ended memberships are history (D44, SCRUM-30/31)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_PUBLIC_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
      }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  interface Setup {
    owner: UserFixture;
    circle: CircleFixture;
    ben: UserFixture;
    benRow: MemberFixture;
    cara: UserFixture;
    caraRow: MemberFixture;
  }
  const setup = async (): Promise<Setup> => {
    const owner = await createUser(client, { fullName: 'Rita Owner' });
    const circle = await createCircle(client, owner);
    const ben = await createUser(client, { fullName: 'Milo Member', phone: fakePhone() });
    const cara = await createUser(client, { fullName: 'Cara Member' });
    const benRow = await addActiveMember(client, circle, ben);
    const caraRow = await addActiveMember(client, circle, cara);
    return { owner, circle, ben, benRow, cara, caraRow };
  };
  const end = async (how: 'removed' | 'left', s: Setup) => {
    const reply =
      how === 'removed'
        ? await removeMember(app, s.owner.id, s.circle.id, s.benRow.id)
        : await leaveCircle(app, s.ben.id, s.circle.id);
    expect(reply.statusCode).toBe(200);
    return reply;
  };
  const code = (reply: { statusCode: number; json: <T>() => T }) => ({
    status: reply.statusCode,
    code: errorOf(reply).code,
  });
  const memberIds = async (callerId: string, circleId: string) =>
    (await listMembers(app, callerId, circleId)).json<Body[]>().map((m) => m.member_id);

  describe.each(['removed', 'left'] as const)('after being %s', (how) => {
    it('the row is kept as history; the response shapes are unchanged', async () => {
      const s = await setup();
      const reply = await end(how, s);
      expect(reply.body).toBe(
        how === 'removed'
          ? JSON.stringify({ removed: true, circle_id: s.circle.id, member_id: s.benRow.id })
          : JSON.stringify({ left: true, circle_id: s.circle.id, member_id: s.benRow.id }),
      );
      const row = await memberRow(client, s.benRow.id);
      expect(row).toMatchObject({
        status: how,
        user_id: s.ben.id,
        invite_token: null,
        activated_at: null,
        display_name: s.ben.fullName,
      });
      expect(row.ended_at).toBeInstanceOf(Date);
      expect(row.invite_consumed_at).not.toBeNull();
    });

    it('member lists, capacity and joined circles ignore the history row', async () => {
      const s = await setup();
      const capacityBefore = (await getCapacity(app, s.owner.id)).json<Body>();
      await end(how, s);
      expect(await memberIds(s.owner.id, s.circle.id)).not.toContain(s.benRow.id);
      expect(await memberIds(s.owner.id, s.circle.id)).toEqual(
        expect.arrayContaining([s.circle.ownerMemberId, s.caraRow.id]),
      );
      expect(await memberIds(s.cara.id, s.circle.id)).not.toContain(s.benRow.id);
      expect(code(await listMembers(app, s.ben.id, s.circle.id))).toEqual({
        status: 403,
        code: 'list_circle_members:not_authorized',
      });
      const capacity = (await getCapacity(app, s.owner.id)).json<Body>();
      expect(capacity).toMatchObject({
        active_count: (capacityBefore.active_count as number) - 1,
        available: (capacityBefore.available as number) + 1,
      });
      expect((await listJoinedCircles(app, s.ben.id)).json<Body[]>()).toEqual([]);
      const caraJoined = (await listJoinedCircles(app, s.cara.id)).json<Body[]>();
      expect(caraJoined).toEqual([
        expect.objectContaining({ circle_id: s.circle.id, active_member_count: 1 }),
      ]);
    });

    it('the old accepted token is refused (not_found); resend and cancel do not find the row', async () => {
      const s = await setup();
      await end(how, s);
      expect((await lookupInvite(app, s.benRow.inviteToken)).json<Body>()).toMatchObject({
        status: 'not_found',
      });
      expect((await previewInvite(app, s.ben.id, s.benRow.inviteToken)).json<Body>()).toMatchObject(
        { status: 'not_found', member_id: null },
      );
      expect(code(await acceptInvite(app, s.ben.id, s.benRow.inviteToken))).toEqual({
        status: 404,
        code: 'accept_circle_invite:not_found',
      });
      expect(code(await resendInvite(app, s.owner.id, s.benRow.id))).toEqual({
        status: 404,
        code: 'resend_circle_invite:member_not_found',
      });
      expect(code(await cancelInvite(app, s.owner.id, s.benRow.id))).toEqual({
        status: 404,
        code: 'cancel_circle_invite:not_found',
      });
      expect((await memberRow(client, s.benRow.id)).status).toBe(how);
      expect((await listMyInvites(app, s.ben.id)).json<Body[]>()).toEqual([]);
    });

    it('rejoin by a NEW link: preview claims and accept activates a new row; history kept', async () => {
      const s = await setup();
      await end(how, s);
      const link = (
        await createInviteLink(app, s.owner.id, { display_name: 'Milo again' })
      ).json<Body>();
      const token = link.invite_token as string;
      const preview = (await previewInvite(app, s.ben.id, token)).json<Body>();
      expect(preview).toMatchObject({ status: 'pending', claimed: true });
      const accepted = await acceptInvite(app, s.ben.id, token);
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json<Body>()).toMatchObject({ status: 'active', member_id: link.member_id });
      // The history row stays (status, names, phone), only its user is released (D41/D44).
      expect(await memberRow(client, s.benRow.id)).toMatchObject({ status: how, user_id: null });
      expect(await memberIds(s.owner.id, s.circle.id)).toContain(link.member_id);
      expect(await memberIds(s.owner.id, s.circle.id)).not.toContain(s.benRow.id);
      expect((await listJoinedCircles(app, s.ben.id)).json<Body[]>()).toEqual([
        expect.objectContaining({ circle_id: s.circle.id, member_id: link.member_id }),
      ]);
      // Accept straight away (no preview) works too, after a second end.
      expect(
        (await removeMember(app, s.owner.id, s.circle.id, link.member_id as string)).statusCode,
      ).toBe(200);
      const second = (await createInviteLink(app, s.owner.id, {})).json<Body>();
      expect(
        (await acceptInvite(app, s.ben.id, second.invite_token as string)).json<Body>(),
      ).toMatchObject({ status: 'active', member_id: second.member_id });
      const audit = await client.query<{ detail: Body }>(
        `select detail from public.audit_log
          where action = 'circle.invite.accepted' and target_id = $1`,
        [second.member_id],
      );
      expect(audit.rows[0].detail).toMatchObject({ released_finished_rows: 1 });
    });

    it('rejoin by a NEW phone invite to the same number: a new row; incoming list and accept work', async () => {
      const s = await setup();
      await end(how, s);
      const reply = await invitePhone(app, s.owner.id, {
        display_name: 'Milo by phone',
        phone: s.ben.phone,
        relationship: 'friend',
      });
      expect(reply.statusCode).toBe(201);
      const invite = reply.json<Body>();
      expect(invite).toMatchObject({ resent: false, phone: s.ben.phone, status: 'pending' });
      expect(invite.member_id).not.toBe(s.benRow.id);
      // The history row gave its phone up and keeps the rest.
      expect(await memberRow(client, s.benRow.id)).toMatchObject({
        status: how,
        phone: null,
        user_id: s.ben.id,
      });
      const incoming = (await listMyInvites(app, s.ben.id)).json<Body[]>();
      expect(incoming.map((i) => i.member_id)).toEqual([invite.member_id]);
      const accepted = await acceptInvite(app, s.ben.id, invite.invite_token as string);
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json<Body>()).toMatchObject({ status: 'active' });
      expect(await memberRow(client, s.benRow.id)).toMatchObject({ status: how, user_id: null });
    });

    it('rejoin by a batch phone invite to the same number creates a new row', async () => {
      const s = await setup();
      await end(how, s);
      const reply = await inviteBatch(app, s.owner.id, {
        invites: [{ display_name: 'Milo batch', phone: s.ben.phone }],
      });
      expect(reply.statusCode).toBe(200);
      const body = reply.json<{ created: Body[]; skipped: Body[]; not_created: Body[] }>();
      expect(body.skipped).toEqual([]);
      expect(body.not_created).toEqual([]);
      expect(body.created).toHaveLength(1);
      expect(body.created[0].member_id).not.toBe(s.benRow.id);
    });

    it('during an active incident: access ends at once for that user only', async () => {
      const s = await setup();
      const incident = (await submitAlert(app, s.owner.id, 'medical')).json<Body>().id as string;
      expect((await getIncidentDetails(app, s.ben.id, incident)).statusCode).toBe(200);
      expect((await getIncidentDetails(app, s.cara.id, incident)).statusCode).toBe(200);
      await end(how, s);
      expect(code(await getIncidentDetails(app, s.ben.id, incident))).toEqual({
        status: 404,
        code: 'get_incident_details:not_found',
      });
      expect(code(await getIncidentEvents(app, s.ben.id, incident)).status).toBe(404);
      expect(code(await getDeliveryCounts(app, s.ben.id, incident)).status).toBe(404);
      expect(code(await acknowledgeIncident(app, s.ben.id, incident)).status).toBe(404);
      expect((await listResponderIncidents(app, s.ben.id)).json<Body[]>()).toEqual([]);
      // The others keep it; the incident goes on.
      expect((await getIncidentDetails(app, s.cara.id, incident)).statusCode).toBe(200);
      expect((await acknowledgeIncident(app, s.cara.id, incident)).statusCode).toBe(200);
      expect((await getDeliveryCounts(app, s.owner.id, incident)).json<Body>()).toMatchObject({
        delivered_count: 1,
      });
      // A member who rejoins later does not see the incident that started before (rule 54).
      const link = (await createInviteLink(app, s.owner.id, {})).json<Body>();
      expect((await acceptInvite(app, s.ben.id, link.invite_token as string)).statusCode).toBe(200);
      expect((await getIncidentDetails(app, s.ben.id, incident)).statusCode).toBe(404);
    });
  });

  it('profile setup re-invites a removed emergency contact as a NEW row (history kept)', async () => {
    const s = await setup();
    const contactPhone = s.ben.phone as string;
    await client.query(
      `update public.profiles set emergency_contact_phone = $2, location_sharing_enabled = true
        where id = $1`,
      [s.owner.id, contactPhone],
    );
    await client.query(`update public.safety_circle_members set phone = $2 where id = $1`, [
      s.benRow.id,
      contactPhone,
    ]);
    await end('removed', s);
    const reply = await completeSetup(app, s.owner.id);
    expect(reply.statusCode).toBe(200);
    const body = reply.json<Body>();
    expect(body).toMatchObject({ circle_id: s.circle.id, member_status: 'pending' });
    expect(body.member_id).not.toBe(s.benRow.id);
    expect(await memberRow(client, s.benRow.id)).toMatchObject({
      status: 'removed',
      phone: null,
      user_id: s.ben.id,
    });
  });

  it('a second remove is 404 and a second leave 403 (as after the SQL delete)', async () => {
    const s = await setup();
    await end('removed', s);
    expect(code(await removeMember(app, s.owner.id, s.circle.id, s.benRow.id))).toEqual({
      status: 404,
      code: 'remove_circle_member:not_found',
    });
    expect(code(await leaveCircle(app, s.ben.id, s.circle.id))).toEqual({
      status: 403,
      code: 'leave_safety_circle:not_authorized',
    });
    expect((await leaveCircle(app, s.cara.id, s.circle.id)).statusCode).toBe(200);
    expect(code(await leaveCircle(app, s.cara.id, s.circle.id))).toEqual({
      status: 403,
      code: 'leave_safety_circle:not_authorized',
    });
  });

  it('the schema refuses an ended status without ended_at, and ended_at on a live row', async () => {
    const s = await setup();
    await expect(
      client.query(`update public.safety_circle_members set status = 'left' where id = $1`, [
        s.caraRow.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(`update public.safety_circle_members set ended_at = now() where id = $1`, [
        s.caraRow.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        `update public.safety_circle_members set status = 'gone', ended_at = now() where id = $1`,
        [s.caraRow.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
