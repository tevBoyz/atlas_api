import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import {
  GENERIC_ERROR_CODES,
  httpStatusForCode,
  PARITY_ERROR_CODES,
} from '../../src/common/errors';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import {
  acceptInvite,
  cancelInvite,
  createInviteLink,
  declineInvite,
  getCapacity,
  getOwnCircle,
  invitePhone,
  inviteBatch,
  leaveCircle,
  listJoinedCircles,
  listMembers,
  listMyInvites,
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
  type UserFixture,
} from '../support/fixtures';
import { insertExpiredMember, insertMember, insertOverCapacity } from '../support/invite-rows';
import { specCircleErrorCodes } from '../support/spec-error-codes';

/**
 * API-100-33 AC2: every circle and invite error code of the specification is produced by a real
 * response. The codes are read from `docs/api_doc.md` (§7.2, §7.3 and the §11.3 rows C1-C11 and
 * I1-I11), not typed here, and must be exactly the parity catalogue of the Phase 2 prefixes plus
 * `test_alerts` (SCRUM-35, rows C7-C11); a generic code a row names (`validation:invalid_request`)
 * must be one of `GENERIC_ERROR_CODES` and is produced like the others. Each
 * producer sends one request (fresh fixtures, so producers do not depend on each other) and checks
 * the envelope's `code` and the HTTP status of spec §11.2. The last test checks that every code was
 * seen in a response.
 *
 * One spec code cannot occur, in the SQL function or in the API, and is proved unreachable instead:
 * `resend_circle_invite:invalid_display_name`. Resend keeps the stored name, and the check
 * constraint `safety_circle_members_display_name_nonempty` makes a blank stored name impossible.
 *
 * `invite_circle_member_by_phone:duplicate_membership` needs a unique clash on the insert whose row
 * is gone on the re-read (spec §7.2). It is produced with a direct-table writer (the RLS owner UPDATE
 * grant of today's app, spec §4.4) changing another row's phone while the invite runs.
 */
type Reply = Awaited<ReturnType<typeof getCapacity>>;

/** The Phase 2 prefixes: spec §7.2, §7.3 (lookup has no codes) and §11.3 C1; SCRUM-35 C7-C11. */
const CIRCLE_PREFIXES = [
  'circle_invite_capacity',
  'invite_circle_member_by_phone',
  'invite_circle_members_by_phone',
  'create_circle_invite_link',
  'resend_circle_invite',
  'cancel_circle_invite',
  'remove_circle_member',
  'list_circle_members',
  'safety_circles',
  'preview_circle_invite',
  'accept_circle_invite',
  'decline_circle_invite',
  'list_my_circle_invites',
  'list_my_joined_circles',
  'leave_safety_circle',
  'test_alerts',
] as const;

/** Spec codes no request can produce, with the reason (checked by its own test). */
const UNREACHABLE: Record<string, string> = {
  'resend_circle_invite:invalid_display_name':
    'resend keeps the stored display_name, which the check constraint ' +
    'safety_circle_members_display_name_nonempty keeps non-blank',
};

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(300 + counter++).padStart(3, '0')}`;

describe('Phase 2 gate: every circle and invite error code of the spec is produced (API-100-33 AC2)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let holders: Client[];
  const produced = new Map<string, number>();

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000', RATE_LIMIT_PUBLIC_MAX: '1000000' }),
    ));
    client = await openTestClient();
    holders = await Promise.all([openTestClient(), openTestClient()]);
  });

  afterAll(async () => {
    await Promise.all((holders ?? []).map((c) => c.end()));
    await client?.end();
    await app?.close();
  });

  /** A request with no Authorization header. */
  const anonymous = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });

  const owner = async (): Promise<{ owner: UserFixture; circle: CircleFixture }> => {
    const user = await createUser(client, { fullName: 'Codes Owner' });
    return { owner: user, circle: await createCircle(client, user) };
  };
  const noProfile = () => createUser(client, { profile: false });
  const sharingOff = async () => {
    const { owner: user } = await owner();
    await client.query(
      'update public.profiles set location_sharing_enabled = false where id = $1',
      [user.id],
    );
    return user;
  };
  /** A circle with 5 valid pending invites (no free slot). */
  const fullCircle = async () => {
    const o = await owner();
    for (let i = 0; i < 5; i += 1) await insertMember(client, o.circle.id);
    return o;
  };
  const fakeId = () => randomUUID();
  /** `POST /v1/me/circle/test-alerts` (C7) with a fresh Idempotency-Key. */
  const sendTestAlert = async (userId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/me/circle/test-alerts',
      headers: { ...(await authHeader(userId)), 'idempotency-key': randomUUID() },
    });

  const PRODUCERS: Record<string, () => Promise<Reply>> = {
    // C2 circle_invite_capacity
    'circle_invite_capacity:not_authenticated': () => getCapacity(app, null),
    'circle_invite_capacity:not_owner': async () => getCapacity(app, (await createUser(client)).id),

    // I1 invite_circle_member_by_phone
    'invite_circle_member_by_phone:not_authenticated': () =>
      anonymous('POST', '/v1/me/circle/invites/phone', {
        display_name: 'X',
        phone: '+12015550100',
      }),
    'invite_circle_member_by_phone:profile_not_found': async () =>
      invitePhone(app, (await noProfile()).id, { display_name: 'X', phone: phoneNumber() }),
    'invite_circle_member_by_phone:location_sharing_disabled': async () =>
      invitePhone(app, (await sharingOff()).id, { display_name: 'X', phone: phoneNumber() }),
    'invite_circle_member_by_phone:circle_not_found': async () =>
      invitePhone(app, (await createUser(client)).id, { display_name: 'X', phone: phoneNumber() }),
    'invite_circle_member_by_phone:invalid_display_name': async () =>
      invitePhone(app, (await owner()).owner.id, { display_name: '   ', phone: phoneNumber() }),
    'invite_circle_member_by_phone:invalid_phone': async () =>
      invitePhone(app, (await owner()).owner.id, { display_name: 'X', phone: '0700900' }),
    'invite_circle_member_by_phone:invalid_relationship': async () =>
      invitePhone(app, (await owner()).owner.id, {
        display_name: 'X',
        phone: phoneNumber(),
        relationship: 'colleague',
      }),
    'invite_circle_member_by_phone:already_active': async () => {
      const o = await owner();
      const phone = phoneNumber();
      await addActiveMember(client, o.circle, await createUser(client, { phone }));
      return invitePhone(app, o.owner.id, { display_name: 'X', phone });
    },
    'invite_circle_member_by_phone:circle_full': async () =>
      invitePhone(app, (await fullCircle()).owner.id, { display_name: 'X', phone: phoneNumber() }),
    'invite_circle_member_by_phone:duplicate_membership': () => duplicatePhoneInvite(),

    // I2 invite_circle_members_by_phone
    'invite_circle_members_by_phone:not_authenticated': () =>
      anonymous('POST', '/v1/me/circle/invites/phone/batch', { invites: [] }),
    'invite_circle_members_by_phone:profile_not_found': async () =>
      inviteBatch(app, (await noProfile()).id, { invites: [] }),
    'invite_circle_members_by_phone:location_sharing_disabled': async () =>
      inviteBatch(app, (await sharingOff()).id, { invites: [] }),
    'invite_circle_members_by_phone:circle_not_found': async () =>
      inviteBatch(app, (await createUser(client)).id, { invites: [] }),
    'invite_circle_members_by_phone:invalid_invites': async () =>
      inviteBatch(app, (await owner()).owner.id, { invites: { phone: '+12015550100' } }),

    // I3 create_circle_invite_link
    'create_circle_invite_link:not_authenticated': () =>
      anonymous('POST', '/v1/me/circle/invites/link', {}),
    'create_circle_invite_link:profile_not_found': async () =>
      createInviteLink(app, (await noProfile()).id, {}),
    'create_circle_invite_link:location_sharing_disabled': async () =>
      createInviteLink(app, (await sharingOff()).id, {}),
    'create_circle_invite_link:circle_not_found': async () =>
      createInviteLink(app, (await createUser(client)).id, {}),
    'create_circle_invite_link:circle_full': async () =>
      createInviteLink(app, (await fullCircle()).owner.id, {}),

    // I4 resend_circle_invite
    'resend_circle_invite:not_authenticated': () =>
      anonymous('POST', `/v1/me/circle/invites/${fakeId()}/resend`),
    'resend_circle_invite:profile_not_found': async () =>
      resendInvite(app, (await noProfile()).id, fakeId()),
    'resend_circle_invite:location_sharing_disabled': async () =>
      resendInvite(app, (await sharingOff()).id, fakeId()),
    'resend_circle_invite:circle_not_found': async () =>
      resendInvite(app, (await createUser(client)).id, fakeId()),
    'resend_circle_invite:member_not_found': async () => {
      const other = await owner();
      const row = await insertMember(client, other.circle.id);
      // A row of another circle is not found in the caller's circle.
      return resendInvite(app, (await owner()).owner.id, row.id);
    },
    'resend_circle_invite:not_invitable': async () => {
      const o = await owner();
      return resendInvite(app, o.owner.id, o.circle.ownerMemberId);
    },
    'resend_circle_invite:already_active': async () => {
      const o = await owner();
      const row = await addActiveMember(client, o.circle, await createUser(client));
      return resendInvite(app, o.owner.id, row.id);
    },
    'resend_circle_invite:circle_full': async () => {
      const o = await fullCircle();
      const declined = await insertMember(client, o.circle.id, {
        status: 'declined',
        canceled: true,
      });
      return resendInvite(app, o.owner.id, declined.id);
    },

    // I5 cancel_circle_invite
    'cancel_circle_invite:not_authenticated': () =>
      anonymous('POST', `/v1/me/circle/invites/${fakeId()}/cancel`),
    'cancel_circle_invite:not_found': async () =>
      cancelInvite(app, (await owner()).owner.id, fakeId()),
    'cancel_circle_invite:not_authorized': async () => {
      const o = await owner();
      const row = await insertMember(client, o.circle.id);
      return cancelInvite(app, (await owner()).owner.id, row.id);
    },
    'cancel_circle_invite:cannot_cancel_owner': async () => {
      const o = await owner();
      return cancelInvite(app, o.owner.id, o.circle.ownerMemberId);
    },
    'cancel_circle_invite:not_pending': async () => {
      const o = await owner();
      const row = await insertMember(client, o.circle.id, { status: 'declined', canceled: true });
      return cancelInvite(app, o.owner.id, row.id);
    },

    // C4 remove_circle_member
    'remove_circle_member:not_authenticated': () =>
      anonymous('DELETE', `/v1/circles/${fakeId()}/members/${fakeId()}`),
    'remove_circle_member:not_found': async () => {
      // D15: a row of another circle is not found under this circle.
      const other = await owner();
      const row = await insertMember(client, other.circle.id);
      const o = await owner();
      return removeMember(app, o.owner.id, o.circle.id, row.id);
    },
    'remove_circle_member:not_authorized': async () => {
      const o = await owner();
      const ben = await createUser(client);
      await addActiveMember(client, o.circle, ben);
      const row = await insertMember(client, o.circle.id);
      return removeMember(app, ben.id, o.circle.id, row.id);
    },
    'remove_circle_member:cannot_remove_owner': async () => {
      const o = await owner();
      return removeMember(app, o.owner.id, o.circle.id, o.circle.ownerMemberId);
    },

    // C3 list_circle_members
    'list_circle_members:not_authenticated': () => listMembers(app, null, fakeId()),
    'list_circle_members:not_found': async () =>
      listMembers(app, (await createUser(client)).id, fakeId()),
    'list_circle_members:not_authorized': async () => {
      const o = await owner();
      return listMembers(app, (await createUser(client)).id, o.circle.id);
    },

    // C1 GET /v1/me/circle
    'safety_circles:not_authenticated': () => getOwnCircle(app, null),

    // I7 preview_circle_invite
    'preview_circle_invite:not_authenticated': () =>
      anonymous('POST', `/v1/invites/${'a'.repeat(64)}/preview`),
    'preview_circle_invite:duplicate_membership': async () => {
      const o = await owner();
      const dan = await createUser(client);
      // D41 (approved by Dawit 2026-11-21): a declined/canceled/expired row of Dan no longer
      // clashes (the API releases it); a still-valid pending row claimed by Dan (two live invites)
      // still does.
      await insertMember(client, o.circle.id, { userId: dan.id, name: 'Claimed' });
      const link = await insertMember(client, o.circle.id);
      return previewInvite(app, dan.id, link.token);
    },

    // I8 accept_circle_invite
    'accept_circle_invite:not_authenticated': () =>
      anonymous('POST', `/v1/invites/${'a'.repeat(64)}/accept`),
    'accept_circle_invite:not_found': async () =>
      acceptInvite(app, (await createUser(client)).id, 'b'.repeat(64)),
    'accept_circle_invite:expired': async () => {
      const o = await owner();
      const row = await insertExpiredMember(client, o.circle.id);
      return acceptInvite(app, (await createUser(client)).id, row.token);
    },
    'accept_circle_invite:consumed': async () => {
      const o = await owner();
      const row = await addActiveMember(client, o.circle, await createUser(client));
      return acceptInvite(app, (await createUser(client)).id, row.inviteToken);
    },
    'accept_circle_invite:canceled': async () => {
      const o = await owner();
      const row = await insertMember(client, o.circle.id, { status: 'declined', canceled: true });
      return acceptInvite(app, (await createUser(client)).id, row.token);
    },
    'accept_circle_invite:not_recipient': async () => {
      const o = await owner();
      const row = await insertMember(client, o.circle.id, { phone: phoneNumber() });
      return acceptInvite(app, (await createUser(client, { phone: phoneNumber() })).id, row.token);
    },
    'accept_circle_invite:own_circle': async () => {
      const o = await owner();
      const row = await insertMember(client, o.circle.id);
      return acceptInvite(app, o.owner.id, row.token);
    },
    'accept_circle_invite:already_member': async () => {
      const o = await owner();
      const ben = await createUser(client);
      await addActiveMember(client, o.circle, ben);
      const row = await insertMember(client, o.circle.id);
      return acceptInvite(app, ben.id, row.token);
    },
    'accept_circle_invite:circle_full': async () => {
      const o = await owner();
      const users = await Promise.all([1, 2, 3, 4, 5].map(() => createUser(client)));
      const rows = await insertOverCapacity(client, o.circle.id, [
        ...users.map((u) => ({ status: 'active' as const, userId: u.id, consumed: true })),
        { name: 'Blocked' },
      ]);
      return acceptInvite(app, (await createUser(client)).id, rows[5].token);
    },
    'accept_circle_invite:duplicate_membership': async () => {
      const o = await owner();
      const dan = await createUser(client);
      await insertMember(client, o.circle.id, { userId: dan.id, name: 'Claimed' });
      const link = await insertMember(client, o.circle.id);
      return acceptInvite(app, dan.id, link.token);
    },

    // I9 decline_circle_invite
    'decline_circle_invite:not_authenticated': () =>
      anonymous('POST', `/v1/invites/${'a'.repeat(64)}/decline`),
    'decline_circle_invite:not_found': async () =>
      declineInvite(app, (await createUser(client)).id, 'c'.repeat(64)),
    'decline_circle_invite:expired': async () => {
      const o = await owner();
      const row = await insertExpiredMember(client, o.circle.id);
      return declineInvite(app, (await createUser(client)).id, row.token);
    },
    'decline_circle_invite:consumed': async () => {
      const o = await owner();
      const row = await addActiveMember(client, o.circle, await createUser(client));
      return declineInvite(app, (await createUser(client)).id, row.inviteToken);
    },
    'decline_circle_invite:canceled': async () => {
      const o = await owner();
      const row = await insertMember(client, o.circle.id);
      const dan = await createUser(client);
      expect((await declineInvite(app, dan.id, row.token)).statusCode).toBe(200);
      // A second decline: the row is now declined.
      return declineInvite(app, dan.id, row.token);
    },
    'decline_circle_invite:not_recipient': async () => {
      const o = await owner();
      const row = await insertMember(client, o.circle.id, { phone: phoneNumber() });
      return declineInvite(app, (await createUser(client)).id, row.token);
    },

    // I10, C6
    'list_my_circle_invites:not_authenticated': () => listMyInvites(app, null),
    'list_my_joined_circles:not_authenticated': () => listJoinedCircles(app, null),

    // C5 leave_safety_circle
    'leave_safety_circle:not_authenticated': () =>
      anonymous('POST', `/v1/circles/${fakeId()}/leave`),
    'leave_safety_circle:not_found': async () =>
      leaveCircle(app, (await createUser(client)).id, fakeId()),
    'leave_safety_circle:is_owner': async () => {
      const o = await owner();
      return leaveCircle(app, o.owner.id, o.circle.id);
    },
    'leave_safety_circle:not_authorized': async () => {
      const o = await owner();
      return leaveCircle(app, (await createUser(client)).id, o.circle.id);
    },

    // C7-C11 test alerts (SCRUM-35, D66-D68)
    'test_alerts:not_authenticated': () => anonymous('GET', '/v1/me/circle/test-alerts/latest'),
    'test_alerts:no_eligible_recipients': async () => sendTestAlert((await owner()).owner.id),
    'test_alerts:rate_limited': async () => {
      const o = await owner();
      await addActiveMember(client, o.circle, await createUser(client));
      expect((await sendTestAlert(o.owner.id)).statusCode).toBe(201);
      return sendTestAlert(o.owner.id);
    },
    'test_alerts:not_found': async () =>
      app.inject({
        method: 'GET',
        url: `/v1/test-alerts/${fakeId()}`,
        headers: await authHeader((await createUser(client)).id),
      }),
    'validation:invalid_request': async () =>
      app.inject({
        method: 'GET',
        url: '/v1/me/circle/test-alerts/not-a-uuid',
        headers: await authHeader((await owner()).owner.id),
      }),
  };

  /**
   * Waits until a backend of the app's pool (not one of `holderPids`) waits on a lock while running
   * a statement that starts with `queryStart` (long statements are cut in pg_stat_activity, so only
   * the start is matched), or until holder `holderPid` waits on a lock.
   */
  async function waitForLockWaiter(
    match: { queryStart: string; holderPids: number[] } | { holderPid: number },
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } =
        'holderPid' in match
          ? await client.query<{ n: number }>(
              `select count(*)::int as n from pg_stat_activity
                where pid = $1 and wait_event_type = 'Lock'`,
              [match.holderPid],
            )
          : await client.query<{ n: number }>(
              `select count(*)::int as n from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
                  and pid <> all($1::int[]) and btrim(query, E' \\n\\r\\t') ilike $2`,
              [match.holderPids, `${match.queryStart}%`],
            );
      if (rows[0].n >= 1) return;
      if (Date.now() > deadline) throw new Error(`no lock waiter: ${JSON.stringify(match)}`);
      await new Promise((done) => setTimeout(done, 10));
    }
  }

  /**
   * `invite_circle_member_by_phone:duplicate_membership`: the insert clashes on `(circle_id, phone)`
   * with a row that no longer has that phone when the invite re-reads it.
   *
   * 1. H1 (a direct-table writer) changes another pending row's phone to P, not yet committed.
   * 2. The API invite for P: its first read does not see H1's change, its insert waits on H1.
   * 3. H2 asks for that row `FOR UPDATE` (waits on H1). H1 commits: the insert sees the clash and
   *    inserts nothing; its re-read (`FOR UPDATE`) now waits on H2, which holds the row.
   * 4. H2 changes the row's phone away from P and commits: the re-read finds no row for P.
   */
  async function duplicatePhoneInvite(): Promise<Reply> {
    const o = await owner();
    const target = phoneNumber();
    const other = await insertMember(client, o.circle.id, { phone: phoneNumber() });
    const [h1, h2] = holders;
    const pidOf = async (c: Client) =>
      (await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
    const holderPids = [await pidOf(h1), await pidOf(h2)];
    let inviting: Promise<Reply> | undefined;
    try {
      await h1.query('begin');
      await h1.query('update public.safety_circle_members set phone = $1 where id = $2', [
        target,
        other.id,
      ]);
      inviting = invitePhone(app, o.owner.id, { display_name: 'Clash', phone: target });
      await waitForLockWaiter({ queryStart: 'insert into', holderPids });
      await h2.query('begin');
      const locking = h2.query(
        'select 1 from public.safety_circle_members where id = $1 for update',
        [other.id],
      );
      await waitForLockWaiter({ holderPid: holderPids[1] });
      await h1.query('commit');
      await locking;
      // The invite's re-read of the phone's row (`select m.id::text ... for update`) waits on H2.
      await waitForLockWaiter({ queryStart: 'select', holderPids });
      await h2.query('update public.safety_circle_members set phone = $1 where id = $2', [
        phoneNumber(),
        other.id,
      ]);
      await h2.query('commit');
      return await inviting;
    } finally {
      // Never leave a holder open (it would block every later test of this file).
      await h1.query('rollback').catch(() => undefined);
      await h2.query('rollback').catch(() => undefined);
      await inviting?.catch(() => undefined);
    }
  }

  const specCodes = specCircleErrorCodes();
  const isGeneric = (code: string) => (GENERIC_ERROR_CODES as readonly string[]).includes(code);
  const specGenericCodes = specCodes.filter(isGeneric);
  const specParityCodes = specCodes.filter((code) => !isGeneric(code));
  const catalogueCodes = CIRCLE_PREFIXES.flatMap((prefix) =>
    PARITY_ERROR_CODES[prefix].map((suffix) => `${prefix}:${suffix}`),
  );

  it('reads the circle and invite codes of spec §7.2, §7.3 and §11.3 C1-C11 / I1-I11', () => {
    expect(new Set(specParityCodes.map((code) => code.split(':')[0]))).toEqual(
      new Set(CIRCLE_PREFIXES),
    );
    expect(specGenericCodes).toEqual(['validation:invalid_request']);
    expect(specParityCodes.length).toBeGreaterThanOrEqual(72);
  });

  it('the spec codes are exactly the parity catalogue for these prefixes', () => {
    expect([...specParityCodes].sort()).toEqual([...catalogueCodes].sort());
  });

  it('has a producer for every spec and catalogue code, except the ones proved unreachable', () => {
    const wanted = new Set([...specCodes, ...catalogueCodes]);
    expect([...wanted].filter((code) => !(code in PRODUCERS) && !(code in UNREACHABLE))).toEqual(
      [],
    );
    expect(Object.keys(PRODUCERS).filter((code) => !wanted.has(code))).toEqual([]);
    expect(Object.keys(UNREACHABLE).filter((code) => !wanted.has(code))).toEqual([]);
  });

  it.each(Object.keys(PRODUCERS))('%s is produced', async (code) => {
    const reply = await PRODUCERS[code]();
    const body = reply.json<{ error: { code: string } }>();
    expect(body.error.code).toBe(code);
    expect(reply.statusCode).toBe(httpStatusForCode(code));
    produced.set(code, reply.statusCode);
  });

  it('resend_circle_invite:invalid_display_name cannot occur: a blank stored name is refused by the database', async () => {
    const o = await owner();
    await expect(
      client.query(
        `insert into public.safety_circle_members (circle_id, role, status, display_name,
           invite_token, invite_expires_at)
         values ($1, 'member', 'pending', '   ', $2, now() + interval '7 days')`,
        [o.circle.id, 'd'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const row = await insertMember(client, o.circle.id);
    await expect(
      client.query(`update public.safety_circle_members set display_name = '' where id = $1`, [
        row.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // The resend of a row with the shortest legal name succeeds.
    await client.query(`update public.safety_circle_members set display_name = 'x' where id = $1`, [
      row.id,
    ]);
    expect((await resendInvite(app, o.owner.id, row.id)).statusCode).toBe(200);
  });

  it('every spec code was seen in a response (or is proved unreachable)', () => {
    expect(specCodes.filter((code) => !produced.has(code) && !(code in UNREACHABLE))).toEqual([]);
    expect(catalogueCodes.filter((code) => !produced.has(code) && !(code in UNREACHABLE))).toEqual(
      [],
    );
  });
});
