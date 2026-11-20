import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { InviteeInvitesRepository } from '../../src/modules/invites/invitee-invites.repository';
import { InviteeInvitesService } from '../../src/modules/invites/invitee-invites.service';
import { createTestApp } from '../../src/testing/test-app';
import { completeSetup } from '../support/profile-api';
import {
  acceptInvite,
  cancelInvite,
  createInviteLink,
  declineInvite,
  errorOf,
  getCapacity,
  listMembers,
  lookupInvite,
  previewInvite,
  resendInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createUser, fakeInviteToken, fakePhone, type UserFixture } from '../support/fixtures';

/**
 * Parity coverage of db/baseline/tests/member_names_expired_invites.sql (API-100-13 AC5). One entry
 * per SQL assertion: the name quotes the SQL message, prefixed with its line in the file.
 *
 * `beforeAll` walks the script's scenario in its order. Reads go through the API: capacity
 * (`GET /v1/me/circle/capacity`, API-100-24), the member list (`GET /v1/circles/{id}/members`,
 * API-100-25) and every token lookup (`GET /v1/invites/{token}/status`, API-100-29). The writes go
 * through the API too: every link invite (`POST /v1/me/circle/invites/link`, API-100-27), every
 * resend and cancel (`POST /v1/me/circle/invites/{id}/resend|cancel`, API-100-28), every preview,
 * accept and decline (`POST /v1/invites/{token}/preview|accept|decline`, API-100-29/30), as the
 * script's callers. Every `complete_profile_setup()` of the script is the API's
 * `POST /v1/me/profile/complete` (API-100-36), and the script's raw inserts/updates stay raw writes
 * as the migration role.
 *
 * L54 (static): the SQL `accept_circle_invite` stores the accepter's name through
 * `_member_profile_name(uid)`, the API's accept (service method and its write) through
 * `memberProfileNameSql(`; neither references location sharing or updates `profiles`. L156/L162
 * show the behaviour.
 *
 * The script has no phone invite: the expired-phone refresh of API-100-26 is covered by
 * test/int/circles-invites.int-spec.ts (incl. its interchangeability tests against the SQL).
 *
 * No `it.todo` left (L137, L404, L418 and L458 completed by API-100-36).
 */
type Member = Record<string, unknown>;
type Body = Record<string, unknown>;

describe('member_names_expired_invites.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;

  let phones: string[];
  let phonesInUse: number;
  let owner: UserFixture;
  let linker: UserFixture;
  let noprof: UserFixture;
  let contact: UserFixture;
  let cid: string;
  let linkerRow: string;
  let link2Id: string;
  let noprofRow: string;
  let oldId: string;
  let contactId: string;
  let tContact: string;
  let setup1: { status: number; body: Body };
  let setup2: { status: number; body: Body };
  let rowAfterSetup2: {
    status: string;
    invite_token: string | null;
    invite_canceled_at: string | null;
    invite_consumed_at: string | null;
    user_id: string | null;
    expires_ok: boolean;
  };
  let setup3: { status: number; body: Body };

  let sqlAcceptSrc: string;
  let apiAcceptSrc: string;
  let linkAccept: { status: number; body: Body };
  let linkerStoredName: string;
  let expiredAccept: { status: number; code: string };
  let old2Lookup: Body;
  let resentLookup: Body;
  let contactDecline: { status: number; body: Body };
  let newContactLookup: Body;
  let oldContactLookup: Body;
  let contactPreview: Body;
  let profilesPolicyOpened: boolean;
  let profileNameCallable: boolean;
  let ownerList1: Member[];
  let link1: Body;
  let tOld: string;
  let resendFull: { status: number; code: string };
  let oldAfterFailedResend: { invite_token: string; status: string };
  let cancelOld2: { status: number; body: Body };
  let old2Row: { status: string; invite_canceled_at: string | null };
  let resendOld: { status: number; body: Body; sixDaysOn: string };
  let cap1: Body;
  let ownerList2: Member[];
  let oldStoredStatus: string;
  let memberListReply: { status: number; body: string; rows: Member[] };
  let cap2: Body;
  let cap3: Body;
  let cap4: Body;
  let cap5: Body;
  let ownerList3: Member[];
  let cap6: Body;

  /** `complete_profile_setup()` as the owner, through the API (API-100-36). */
  const setupViaApi = async (user: UserFixture) => {
    const reply = await completeSetup(app, user.id);
    return { status: reply.statusCode, body: reply.json<Body>() };
  };

  const capacityOf = async (user: UserFixture): Promise<Body> => {
    const reply = await getCapacity(app, user.id);
    expect(reply.statusCode).toBe(200);
    return reply.json<Body>();
  };

  const listOf = async (user: UserFixture): Promise<Member[]> => {
    const reply = await listMembers(app, user.id, cid);
    expect(reply.statusCode).toBe(200);
    return reply.json<Member[]>();
  };

  const find = (rows: Member[], memberId: string) => rows.find((e) => e.member_id === memberId);

  /** `create_circle_invite_link(null)` as the owner, through the API (API-100-27). */
  const linkViaApi = async (): Promise<Body> => {
    const reply = await createInviteLink(app, owner.id, { display_name: null });
    expect(reply.statusCode).toBe(201);
    return reply.json<Body>();
  };

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    // Static check (L54): the SQL function and the API's accept.
    sqlAcceptSrc = (
      await client.query<{ src: string }>(
        `select pg_get_functiondef('public.accept_circle_invite(text)'::regprocedure) as src`,
      )
    ).rows[0].src;
    apiAcceptSrc = [
      String(Object.getOwnPropertyDescriptor(InviteeInvitesService.prototype, 'accept')?.value),
      String(
        Object.getOwnPropertyDescriptor(InviteeInvitesRepository.prototype, 'acceptWrite')?.value,
      ),
    ].join('\n');

    // Static checks (L65, L70): the API reads profile names itself; RLS stays closed.
    profilesPolicyOpened =
      (
        await client.query<{ n: number }>(
          `select count(*)::int as n from pg_policies pol
          where pol.schemaname = 'public' and pol.tablename = 'profiles'
            and pol.cmd in ('SELECT', 'ALL') and pol.qual ilike '%safety_circle%'`,
        )
      ).rows[0].n > 0;
    profileNameCallable = (
      await client.query<{ callable: boolean }>(
        `select has_function_privilege('authenticated', 'public._member_profile_name(uuid)', 'execute')
             or has_function_privilege('anon', 'public._member_profile_name(uuid)', 'execute')
             as callable`,
      )
    ).rows[0].callable;

    // Fixtures (L89): five fake phones nobody uses yet.
    phones = Array.from({ length: 5 }, () => fakePhone());
    phonesInUse = (
      await client.query<{ n: number }>(
        `select ((select count(*) from auth.users u
                  where u.phone = any($1) or ('+' || u.phone) = any($1))
              + (select count(*) from public.safety_circle_members m where m.phone = any($1))
              + (select count(*) from public.profiles p where p.emergency_contact_phone = any($1)))::int
              as n`,
        [phones],
      )
    ).rows[0].n;
    const [phoneOwner, phoneLinker, phoneNoprof, phoneContact, phoneOutsider] = phones;
    owner = await createUser(client, { fullName: 'Owner Names', phone: phoneOwner });
    linker = await createUser(client, { fullName: 'Link Joiner', phone: phoneLinker });
    noprof = await createUser(client, { phone: phoneNoprof, profile: false });
    contact = await createUser(client, { fullName: 'Contact Account', phone: phoneContact });
    const outsider = await createUser(client, { fullName: 'Outsider', phone: phoneOutsider });
    await client.query(
      `update public.profiles
          set emergency_contact_full_name = 'Contact Person',
              emergency_contact_relationship = 'friend',
              emergency_contact_phone = $2,
              location_sharing_enabled = true
        where id = $1`,
      [owner.id, phoneContact],
    );

    // Owner completes setup: circle + owner row + contact pending invite (API-100-36).
    setup1 = await setupViaApi(owner);
    cid = setup1.body.circle_id as string;
    contactId = setup1.body.member_id as string;
    // Link invite (API-100-27), accepted by the linker (API-100-30): stored under the profile name.
    link1 = await linkViaApi();
    linkerRow = link1.member_id as string;
    const accepted = await acceptInvite(app, linker.id, link1.invite_token as string);
    linkAccept = { status: accepted.statusCode, body: accepted.json<Body>() };
    linkerStoredName = (
      await client.query<{ name: string }>(
        'select display_name as name from public.safety_circle_members where id = $1',
        [linkerRow],
      )
    ).rows[0].name;

    // Active member without a profile keeps the stored name.
    noprofRow = randomUUID();
    await client.query(
      `insert into public.safety_circle_members (id, circle_id, role, status, display_name, user_id,
                                                 invite_consumed_at)
       values ($1, $2, 'member', 'active', 'Stored Name', $3, now())`,
      [noprofRow, cid, noprof.id],
    );
    link2Id = (await linkViaApi()).member_id as string;
    // A pre-fix row: active with the placeholder name.
    await client.query(
      `update public.safety_circle_members set display_name = 'Invited member' where id = $1`,
      [linkerRow],
    );
    ownerList1 = await listOf(owner);

    // #14: an expired pending row does not use a slot.
    oldId = randomUUID();
    tOld = fakeInviteToken();
    await client.query(
      `insert into public.safety_circle_members (id, circle_id, role, status, display_name,
         invite_token, invited_at, invite_expires_at)
       values ($1, $2, 'member', 'pending', 'Old Invite', $3, now() - interval '10 days',
               now() - interval '3 days')`,
      [oldId, cid, tOld],
    );
    cap1 = await capacityOf(owner);
    ownerList2 = await listOf(owner);
    oldStoredStatus = (
      await client.query<{ status: string }>(
        'select status from public.safety_circle_members where id = $1',
        [oldId],
      )
    ).rows[0].status;

    // Members never see pending or expired rows.
    const memberReply = await listMembers(app, linker.id, cid);
    memberListReply = {
      status: memberReply.statusCode,
      body: memberReply.body,
      rows: memberReply.json<Member[]>(),
    };

    // Accepting an expired token still fails (an outsider, API-100-30).
    const expiredReply = await acceptInvite(app, outsider.id, tOld);
    expiredAccept = { status: expiredReply.statusCode, code: errorOf(expiredReply).code };

    // Fill to 5/5 (API link invite); a resend of the expired invite re-checks capacity (API).
    const fillId = (await linkViaApi()).member_id as string;
    cap2 = await capacityOf(owner);
    const fullReply = await resendInvite(app, owner.id, oldId);
    resendFull = { status: fullReply.statusCode, code: errorOf(fullReply).code };
    oldAfterFailedResend = (
      await client.query<{ invite_token: string; status: string }>(
        'select invite_token, status from public.safety_circle_members where id = $1',
        [oldId],
      )
    ).rows[0];

    // An expired row can be inserted at 5/5 (holds no slot) and canceled (API).
    const old2Id = randomUUID();
    const tOld2 = fakeInviteToken();
    await client.query(
      `insert into public.safety_circle_members (id, circle_id, role, status, display_name,
         invite_token, invited_at, invite_expires_at)
       values ($1, $2, 'member', 'pending', 'Old Two', $3, now() - interval '9 days',
               now() - interval '2 days')`,
      [old2Id, cid, tOld2],
    );
    const cancelReply = await cancelInvite(app, owner.id, old2Id);
    cancelOld2 = { status: cancelReply.statusCode, body: cancelReply.json<Body>() };
    old2Row = (
      await client.query<{ status: string; invite_canceled_at: string | null }>(
        'select status, invite_canceled_at from public.safety_circle_members where id = $1',
        [old2Id],
      )
    ).rows[0];
    old2Lookup = (await lookupInvite(app, tOld2)).json<Body>();
    cap3 = await capacityOf(owner);

    // Free one slot (API cancel), then resend the expired invite (API): same row, new token.
    expect((await cancelInvite(app, owner.id, fillId)).statusCode).toBe(200);
    cap4 = await capacityOf(owner);
    const sixDaysOn = (
      await client.query<{ t: string }>(
        `select (extract(epoch from now() + interval '6 days') * 1000)::bigint::text as t`,
      )
    ).rows[0].t;
    const resent = await resendInvite(app, owner.id, oldId);
    resendOld = { status: resent.statusCode, body: resent.json<Body>(), sixDaysOn };
    resentLookup = (await lookupInvite(app, resendOld.body.invite_token as string)).json<Body>();
    cap5 = await capacityOf(owner);
    ownerList3 = await listOf(owner);

    // The contact declines (API); complete_profile_setup re-run (SQL, API-100-36) gives a usable
    // invite; lookups and preview (API), decline again (API), refill (API link invite).
    tContact = (
      await client.query<{ t: string }>(
        'select invite_token as t from public.safety_circle_members where id = $1',
        [contactId],
      )
    ).rows[0].t;
    const declineReply = await declineInvite(app, contact.id, tContact);
    contactDecline = { status: declineReply.statusCode, body: declineReply.json<Body>() };
    setup2 = await setupViaApi(owner);
    rowAfterSetup2 = (
      await client.query<typeof rowAfterSetup2>(
        `select m.status, m.invite_token, m.invite_canceled_at::text, m.invite_consumed_at::text,
                m.user_id::text, m.invite_expires_at >= now() + interval '6 days' as expires_ok
           from public.safety_circle_members m where m.id = $1`,
        [contactId],
      )
    ).rows[0];
    const tContactNew = rowAfterSetup2.invite_token as string;
    newContactLookup = (await lookupInvite(app, tContactNew)).json<Body>();
    oldContactLookup = (await lookupInvite(app, tContact)).json<Body>();
    contactPreview = (await previewInvite(app, contact.id, tContactNew)).json<Body>();
    expect((await declineInvite(app, contact.id, tContactNew)).statusCode).toBe(200);
    await linkViaApi();
    cap6 = await capacityOf(owner);
    // Re-run at 5/5: Complete still succeeds and the contact row is left declined (no slot).
    setup3 = await setupViaApi(owner);
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  it('L54: accept_circle_invite name write missing or touches profiles/location', () => {
    expect(sqlAcceptSrc).toMatch(/_member_profile_name\(uid\)/i);
    expect(apiAcceptSrc).toMatch(/memberProfileNameSql\(/);
    for (const src of [sqlAcceptSrc, apiAcceptSrc]) {
      expect(src).not.toMatch(/location_sharing/i);
      expect(src).not.toMatch(/update public\.profiles/i);
    }
  });

  it('L65: profiles RLS was opened to circle members', () => {
    expect(profilesPolicyOpened).toBe(false);
    // The API gives members a profile's name and photo URL only (8 keys, no profile columns).
    for (const row of memberListReply.rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'avatar_url',
          'display_name',
          'invited_at',
          'is_owner',
          'member_id',
          'role',
          'status',
          'user_id',
        ].sort(),
      );
    }
  });

  it('L70: _member_profile_name is callable by clients', () => {
    expect(profileNameCallable).toBe(false);
  });

  it('L89: could not allocate test phones', () => {
    expect(new Set(phones).size).toBe(5);
    expect(phonesInUse).toBe(0);
  });

  it('L137: setup failed: %', () => {
    expect(setup1.status).toBe(200);
    expect(cid).toEqual(expect.any(String));
    expect(setup1.body.member_status).toBe('pending');
  });
  it('L144: link placeholder changed: %', () => {
    expect(link1.display_name).toBe('Invited member');
  });
  it('L156: link accept failed: %', () => {
    expect(linkAccept.status).toBe(200);
    expect(linkAccept.body.status).toBe('active');
  });

  it('L162: accept did not store the profile name: %', () => {
    expect(linkerStoredName).toBe('Link Joiner');
  });

  it('L195: owner list did not show profile name: %', () => {
    const elem = find(ownerList1, linkerRow);
    expect(elem?.display_name).toBe('Link Joiner');
    expect(elem?.status).toBe('active');
    expect(elem).toHaveProperty('avatar_url');
  });

  it('L202: pending link invite lost its placeholder: %', () => {
    const elem = find(ownerList1, link2Id);
    expect(elem?.display_name).toBe('Invited member');
    expect(elem?.status).toBe('pending');
  });

  it('L208: no-profile fallback failed: %', () => {
    expect(find(ownerList1, noprofRow)?.display_name).toBe('Stored Name');
  });

  it('L214: owner row name failed: %', () => {
    expect(ownerList1.find((e) => e.is_owner === true)?.display_name).toBe('Owner Names');
  });

  it('L235: expired counted in capacity: %', () => {
    // active: linker, noprof. valid pending: contact, link2. expired: old.
    expect(cap1).toEqual({ limit: 5, active_count: 2, pending_count: 2, used: 4, available: 1 });
  });

  it('L244: owner list missing expired row: %', () => {
    const elem = find(ownerList2, oldId);
    expect(elem).toBeDefined();
    expect(elem?.status).toBe('expired');
    expect(elem?.display_name).toBe('Old Invite');
  });

  it('L248: stored status changed: %', () => {
    expect(oldStoredStatus).toBe('pending');
  });

  it('L264: member list leaked pending/expired/contact: %', () => {
    expect(memberListReply.status).toBe(200);
    for (const e of memberListReply.rows) {
      expect(['pending', 'expired', 'declined']).not.toContain(e.status);
      expect(e).not.toHaveProperty('phone');
      expect(e).not.toHaveProperty('email');
      expect(e).not.toHaveProperty('relationship');
    }
  });

  it('L269: member list did not show profile name: %', () => {
    expect(find(memberListReply.rows, linkerRow)?.display_name).toBe('Link Joiner');
  });

  it('L281: expired accept did not raise', () => {
    expect(expiredAccept.status).toBe(410);
  });

  it('L285: expired accept got %', () => {
    expect(expiredAccept.code).toBe('accept_circle_invite:expired');
  });

  it('L302: fill failed: %', () => {
    expect(cap2).toMatchObject({ used: 5, available: 0 });
  });

  it('L307: resend at 5/5 did not raise', () => {
    expect(resendFull.status).toBe(409);
  });

  it('L311: resend at 5/5 got %', () => {
    expect(resendFull.code).toBe('resend_circle_invite:circle_full');
  });

  it('L317: failed resend wrote the row', () => {
    expect(oldAfterFailedResend).toEqual({ invite_token: tOld, status: 'pending' });
  });

  it('L334: cancel on expired failed: %', () => {
    expect(cancelOld2.status).toBe(200);
    expect(cancelOld2.body.status).toBe('canceled');
    expect(typeof cancelOld2.body.member_id).toBe('string');
  });

  it('L339: cancel on expired did not decline', () => {
    expect(old2Row.status).toBe('declined');
    expect(old2Row.invite_canceled_at).not.toBeNull();
  });
  it('L342: canceled expired token lookup wrong', () => {
    expect(old2Lookup.status).toBe('canceled');
  });

  it('L346: cancel on expired changed capacity: %', () => {
    expect(cap3.used).toBe(5);
  });

  it('L353: cancel did not free a slot: %', () => {
    expect(cap4.used).toBe(4);
  });

  it('L362: resend on expired failed: %', () => {
    expect(resendOld.status).toBe(200);
    expect(resendOld.body.member_id).toBe(oldId);
    expect(resendOld.body.status).toBe('pending');
    expect(resendOld.body.invite_token).toEqual(expect.any(String));
    expect(resendOld.body.invite_token).not.toBe(tOld);
    expect(Date.parse(resendOld.body.invite_expires_at as string)).toBeGreaterThanOrEqual(
      Number(resendOld.sixDaysOn),
    );
  });
  it('L365: resent token is not pending', () => {
    expect(resentLookup.status).toBe('pending');
  });

  it('L370: resend did not take the slot: %', () => {
    expect(cap5).toMatchObject({ used: 5, pending_count: 3 });
  });

  it('L376: resent row not listed pending: %', () => {
    expect(find(ownerList3, oldId)?.status).toBe('pending');
  });

  it('L391: contact decline failed: %', () => {
    expect(contactDecline.status).toBe(200);
    expect(contactDecline.body.status).toBe('declined');
  });
  it('L404: setup re-run after decline failed: %', () => {
    expect(setup2.status).toBe(200);
    expect(setup2.body.member_id).toBe(contactId);
    expect(setup2.body.member_status).toBe('pending');
  });

  it('L418: setup re-run left an unusable invite', () => {
    expect(rowAfterSetup2.status).toBe('pending');
    expect(rowAfterSetup2.invite_canceled_at).toBeNull();
    expect(rowAfterSetup2.invite_consumed_at).toBeNull();
    expect(rowAfterSetup2.user_id).toBeNull();
    expect(rowAfterSetup2.invite_token).not.toBeNull();
    expect(rowAfterSetup2.invite_token).not.toBe(tContact);
    expect(rowAfterSetup2.expires_ok).toBe(true);
  });
  it('L421: setup re-run token does not look up as pending: %', () => {
    expect(newContactLookup.status).toBe('pending');
  });

  it('L425: old declined token still resolves', () => {
    expect(oldContactLookup.status).toBe('not_found');
  });

  it('L437: contact preview after re-run failed: %', () => {
    expect(contactPreview.status).toBe('pending');
  });

  it('L452: refill failed: %', () => {
    expect(cap6.available).toBe(0);
  });

  it('L458: setup re-run at 5/5 failed: %', () => {
    expect(setup3.status).toBe(200);
    expect(setup3.body.member_id).toBe(contactId);
    expect(setup3.body.member_status).toBe('declined');
    expect(setup3.body.profile_setup_completed_at).not.toBeNull();
  });
});
