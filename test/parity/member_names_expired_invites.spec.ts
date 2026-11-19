import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp } from '../../src/testing/test-app';
import {
  cancelInvite,
  createInviteLink,
  errorOf,
  getCapacity,
  listMembers,
  resendInvite,
  sqlAs,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createUser, fakeInviteToken, fakePhone, type UserFixture } from '../support/fixtures';

/**
 * Parity coverage of db/baseline/tests/member_names_expired_invites.sql (API-100-13 AC5). One entry
 * per SQL assertion: the name quotes the SQL message, prefixed with its line in the file.
 *
 * `beforeAll` walks the script's scenario in its order. Reads go through the API: capacity
 * (`GET /v1/me/circle/capacity`, API-100-24) and the member list (`GET /v1/circles/{id}/members`,
 * API-100-25). The owner's invite writes go through the API too: every link invite
 * (`POST /v1/me/circle/invites/link`, API-100-27), every resend and cancel
 * (`POST /v1/me/circle/invites/{id}/resend|cancel`, API-100-28). Writes the API does not have yet
 * are done as the script does them: the SQL functions (`complete_profile_setup`,
 * `accept_circle_invite`, `decline_circle_invite`, `preview_circle_invite`) as the same callers, and
 * raw inserts/updates as the migration role. The story that ships each write replaces the SQL call
 * with the API call.
 *
 * Done here: API-100-24/25 the capacity reads (L235, L302, L346, L353, L370, L452), the member list
 * names, statuses and visibility (L195, L202, L208, L214, L244, L248, L264, L269, L376), the two
 * static privacy checks about profile names (L65, L70) and the fixture phones (L89); API-100-27 the
 * link placeholder (L144); API-100-28 resend at 5/5 (L307, L311, L317), cancel of an expired invite
 * (L334, L339) and resend of an expired invite (L362).
 *
 * The script has no phone invite: the expired-phone refresh of API-100-26 is covered by
 * test/int/circles-invites.int-spec.ts (incl. its interchangeability tests against the SQL).
 *
 * Still `it.todo`, with the story that completes them:
 * - API-100-29 (lookup / preview): L342, L365, L421, L425, L437.
 * - API-100-30 (accept / decline): L54, L156, L162, L281, L285, L391.
 * - API-100-36 (complete setup): L137, L404, L418, L458.
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

  const asUser = <T>(user: UserFixture, call: string, params: unknown[] = []) =>
    sqlAs<T>(client, user.id, call, params);

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
    await createUser(client, { fullName: 'Outsider', phone: phoneOutsider });
    await client.query(
      `update public.profiles
          set emergency_contact_full_name = 'Contact Person',
              emergency_contact_relationship = 'friend',
              emergency_contact_phone = $2,
              location_sharing_enabled = true
        where id = $1`,
      [owner.id, phoneContact],
    );

    // Owner completes setup: circle + owner row + contact pending invite (SQL, API-100-36).
    const setup = await asUser<Body>(owner, 'public.complete_profile_setup()');
    cid = setup.circle_id as string;
    const contactId = setup.member_id as string;
    // Link invite through the API (API-100-27); accepted through SQL (API-100-30).
    link1 = await linkViaApi();
    linkerRow = link1.member_id as string;
    await asUser(linker, 'public.accept_circle_invite($1)', [link1.invite_token]);

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
    await client.query(
      `insert into public.safety_circle_members (id, circle_id, role, status, display_name,
         invite_token, invited_at, invite_expires_at)
       values ($1, $2, 'member', 'pending', 'Old Two', $3, now() - interval '9 days',
               now() - interval '2 days')`,
      [old2Id, cid, fakeInviteToken()],
    );
    const cancelReply = await cancelInvite(app, owner.id, old2Id);
    cancelOld2 = { status: cancelReply.statusCode, body: cancelReply.json<Body>() };
    old2Row = (
      await client.query<{ status: string; invite_canceled_at: string | null }>(
        'select status, invite_canceled_at from public.safety_circle_members where id = $1',
        [old2Id],
      )
    ).rows[0];
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
    cap5 = await capacityOf(owner);
    ownerList3 = await listOf(owner);

    // complete_profile_setup re-run after decline (SQL), decline again, refill (API link invite).
    const tContact = (
      await client.query<{ t: string }>(
        'select invite_token as t from public.safety_circle_members where id = $1',
        [contactId],
      )
    ).rows[0].t;
    await asUser(contact, 'public.decline_circle_invite($1)', [tContact]);
    await asUser(owner, 'public.complete_profile_setup()');
    const tContactNew = (
      await client.query<{ t: string }>(
        'select invite_token as t from public.safety_circle_members where id = $1',
        [contactId],
      )
    ).rows[0].t;
    await asUser(contact, 'public.preview_circle_invite($1)', [tContactNew]);
    await asUser(contact, 'public.decline_circle_invite($1)', [tContactNew]);
    await linkViaApi();
    cap6 = await capacityOf(owner);
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  it.todo('L54: accept_circle_invite name write missing or touches profiles/location');

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

  it.todo('L137: setup failed: %');
  it('L144: link placeholder changed: %', () => {
    expect(link1.display_name).toBe('Invited member');
  });
  it.todo('L156: link accept failed: %');
  it.todo('L162: accept did not store the profile name: %');

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

  it.todo('L281: expired accept did not raise');
  it.todo('L285: expired accept got %');

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
  it.todo('L342: canceled expired token lookup wrong');

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
  it.todo('L365: resent token is not pending');

  it('L370: resend did not take the slot: %', () => {
    expect(cap5).toMatchObject({ used: 5, pending_count: 3 });
  });

  it('L376: resent row not listed pending: %', () => {
    expect(find(ownerList3, oldId)?.status).toBe('pending');
  });

  it.todo('L391: contact decline failed: %');
  it.todo('L404: setup re-run after decline failed: %');
  it.todo('L418: setup re-run left an unusable invite');
  it.todo('L421: setup re-run token does not look up as pending: %');
  it.todo('L425: old declined token still resolves');
  it.todo('L437: contact preview after re-run failed: %');

  it('L452: refill failed: %', () => {
    expect(cap6.available).toBe(0);
  });

  it.todo('L458: setup re-run at 5/5 failed: %');
});
