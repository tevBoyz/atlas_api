import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  cancelInvite,
  createInviteLink,
  errorOf,
  getCapacity,
  invitePhone,
  inviteBatch,
  resendInvite,
  sqlAs,
  sqlRolledBack,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  fakeInviteToken,
  type UserFixture,
} from '../support/fixtures';

/**
 * The owner's invitations (API-100-26 invite by phone and batch, API-100-27 link, API-100-28 resend
 * and cancel) beyond the SQL scripts: every acceptance criterion, the check order and codes against
 * the SQL functions, the exact JSON, row effects and codes of the SQL function for the same state and
 * caller (interchangeability), audit without personal data, Idempotency-Key, and that no route of
 * this round can make a member row `active` (spec §4.4 "known bypass").
 */
type Body = Record<string, unknown>;

/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
let inviteCounter = 0;
const invitePhoneNumber = () => `+447700900${String(inviteCounter++).padStart(3, '0')}`;

const BASE = 'io.supabase.atlasmobile://invite/';
const TOKEN = /^[0-9a-f]{64}$/;
const PAYLOAD_KEYS = [
  'member_id',
  'circle_id',
  'status',
  'display_name',
  'relationship',
  'phone',
  'invite_token',
  'invite_url',
  'invited_at',
  'invite_expires_at',
  'resent',
];
const DAY_MS = 86_400_000;

describe('owner invitations (API-100-26/27/28)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000' }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  // --- fixtures ----------------------------------------------------------------------------------

  interface Owned {
    owner: UserFixture;
    circle: CircleFixture;
  }

  const ownerWithCircle = async (fullName = 'Ada Owner'): Promise<Owned> => {
    const owner = await createUser(client, { fullName });
    return { owner, circle: await createCircle(client, owner) };
  };

  interface RowOptions {
    name?: string;
    phone?: string | null;
    status?: 'pending' | 'declined' | 'active';
    expiresSql?: string;
    invitedSql?: string;
    canceled?: boolean;
    consumed?: boolean;
    userId?: string | null;
    relationship?: string | null;
  }

  /** A member row in any state, written as the migration role (the triggers still run). */
  const insertRow = async (circle: CircleFixture, options: RowOptions = {}): Promise<string> => {
    const id = randomUUID();
    await client.query(
      `insert into public.safety_circle_members (id, circle_id, role, status, display_name,
         relationship, phone, user_id, invite_token, invited_at, invite_expires_at,
         invite_canceled_at, invite_consumed_at)
       values ($1, $2, 'member', $3, $4, $5, $6, $7, $8, ${options.invitedSql ?? 'now()'},
               ${options.expiresSql ?? "now() + interval '7 days'"},
               case when $9::boolean then now() end, case when $10::boolean then now() end)`,
      [
        id,
        circle.id,
        options.status ?? 'pending',
        options.name ?? 'Row Name',
        options.relationship === undefined ? 'friend' : options.relationship,
        options.phone === undefined ? null : options.phone,
        options.userId ?? null,
        fakeInviteToken(),
        options.canceled ?? false,
        options.consumed ?? false,
      ],
    );
    return id;
  };
  const insertExpired = (circle: CircleFixture, options: RowOptions = {}) =>
    insertRow(circle, {
      invitedSql: "now() - interval '10 days'",
      expiresSql: "now() - interval '3 days'",
      ...options,
    });
  /** `n` valid pending link-style rows (each holds a slot). */
  const fillPending = async (circle: CircleFixture, n: number) => {
    for (let i = 0; i < n; i += 1) await insertRow(circle, { name: `Filler ${i}` });
  };

  const rowOf = async (id: string) =>
    (
      await client.query<Body>(
        `select m.*, (m.invite_expires_at - m.invited_at) = interval '7 days' as seven_days
           from public.safety_circle_members m where m.id = $1`,
        [id],
      )
    ).rows[0];
  const rowCount = async (circle: CircleFixture) =>
    (
      await client.query<{ n: number }>(
        'select count(*)::int as n from public.safety_circle_members where circle_id = $1',
        [circle.id],
      )
    ).rows[0].n;
  const capacityOf = async (user: UserFixture) => (await getCapacity(app, user.id)).json<Body>();
  const lookup = async (token: string) =>
    (await sqlAs<Body>(client, randomUUID(), 'public.lookup_circle_invite($1)', [token])).status;
  const auditRows = async (targetId: string) =>
    (
      await client.query<{ action: string; target_type: string; detail: Body; actor: string }>(
        `select action, target_type, detail, actor_user_id::text as actor
           from public.audit_log where target_id = $1 order by id`,
        [targetId],
      )
    ).rows;

  /** The SQL function's `fn:code` for the same call, in a rolled-back transaction. */
  const sqlCode = async (user: UserFixture, call: string, params: unknown[] = []) =>
    (await sqlRolledBack(client, user.id, call, params)).error;

  const expectPayload = (body: Body) => {
    expect(Object.keys(body).sort()).toEqual([...PAYLOAD_KEYS].sort());
    expect(body.invite_token).toMatch(TOKEN);
    expect(body.invite_url).toBe(`${BASE}${body.invite_token as string}`);
    expect(body.status).toBe('pending');
    expect(
      Date.parse(body.invite_expires_at as string) - Date.parse(body.invited_at as string),
    ).toBe(7 * DAY_MS);
    expect(body.invited_at).toMatch(/\+00:00$/);
  };

  // --- API-100-26 AC1: owner precondition (spec rule 11) -----------------------------------------

  describe('owner precondition, in the SQL order and with its codes', () => {
    const routes: Array<{
      fn: string;
      call: (userId: string | null) => ReturnType<typeof invitePhone>;
      sql: string;
      params: unknown[];
    }> = [
      {
        fn: 'invite_circle_member_by_phone',
        call: (u) => invitePhone(app, u, { display_name: '', phone: 'x', relationship: 'cousin' }),
        sql: 'public.invite_circle_member_by_phone($1, $2, $3)',
        params: ['', 'x', 'cousin'],
      },
      {
        fn: 'invite_circle_members_by_phone',
        call: (u) => inviteBatch(app, u, { invites: 'not an array' }),
        sql: 'public.invite_circle_members_by_phone($1::jsonb)',
        params: [JSON.stringify('not an array')],
      },
      {
        fn: 'create_circle_invite_link',
        call: (u) => createInviteLink(app, u, {}),
        sql: 'public.create_circle_invite_link(null)',
        params: [],
      },
      {
        fn: 'resend_circle_invite',
        call: (u) => resendInvite(app, u, randomUUID()),
        sql: 'public.resend_circle_invite($1)',
        params: [randomUUID()],
      },
    ];

    it.each(routes)('$fn: 401 without a token', async ({ fn, call }) => {
      const reply = await call(null);
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe(`${fn}:not_authenticated`);
    });

    it.each(routes)(
      '$fn: no profile 404, sharing off 409, no circle 404 (before any argument check), as SQL',
      async ({ fn, call, sql, params }) => {
        const noProfile = await createUser(client, { profile: false });
        const sharingOff = await ownerWithCircle();
        await client.query(
          'update public.profiles set location_sharing_enabled = false where id = $1',
          [sharingOff.owner.id],
        );
        const noCircle = await createUser(client);
        const cases: Array<[UserFixture, number, string]> = [
          [noProfile, 404, 'profile_not_found'],
          [sharingOff.owner, 409, 'location_sharing_disabled'],
          [noCircle, 404, 'circle_not_found'],
        ];
        for (const [user, status, code] of cases) {
          const reply = await call(user.id);
          expect(reply.statusCode).toBe(status);
          expect(errorOf(reply).code).toBe(`${fn}:${code}`);
          expect(await sqlCode(user, sql, params)).toBe(`${fn}:${code}`);
        }
      },
    );
  });

  // --- API-100-26 AC2-4, AC6, AC7: single phone invite -------------------------------------------

  describe('POST /v1/me/circle/invites/phone', () => {
    it('201 a new pending invite: MemberInvitePayload, 64-hex token, 7 days, no user, no activation', async () => {
      const { owner, circle } = await ownerWithCircle();
      const phone = invitePhoneNumber();
      const reply = await invitePhone(app, owner.id, {
        display_name: '  Ben Phone  ',
        phone: `  ${phone}  `,
        relationship: ' sibling ',
      });
      expect(reply.statusCode).toBe(201);
      const body = reply.json<Body>();
      expectPayload(body);
      expect(body).toMatchObject({
        circle_id: circle.id,
        display_name: 'Ben Phone',
        phone,
        relationship: 'sibling',
        resent: false,
      });
      const row = await rowOf(body.member_id as string);
      expect(row).toMatchObject({
        role: 'member',
        status: 'pending',
        user_id: null,
        email: null,
        activated_at: null,
        invite_token: body.invite_token,
        invite_consumed_at: null,
        invite_canceled_at: null,
        seven_days: true,
      });
      expect(await lookup(body.invite_token as string)).toBe('pending');
      expect((await capacityOf(owner)).pending_count).toBe(1);
    });

    it('audits circle.invite.created with ids only: no phone, name or token', async () => {
      const { owner, circle } = await ownerWithCircle();
      const phone = invitePhoneNumber();
      const body = (
        await invitePhone(app, owner.id, { display_name: 'Audit Person', phone })
      ).json<Body>();
      const rows = await auditRows(body.member_id as string);
      expect(rows).toEqual([
        {
          action: 'circle.invite.created',
          target_type: 'circle_member',
          actor: owner.id,
          detail: { circle_id: circle.id, channel: 'phone' },
        },
      ]);
      const text = JSON.stringify(rows);
      expect(text).not.toContain(phone.slice(1));
      expect(text).not.toContain('Audit Person');
      expect(text).not.toContain(body.invite_token as string);
    });

    it('validation in the SQL order with its codes (name, then phone, then relationship)', async () => {
      const { owner } = await ownerWithCircle();
      const good = invitePhoneNumber();
      const cases: Array<[Body, string]> = [
        [{ display_name: '   ', phone: 'bad', relationship: 'cousin' }, 'invalid_display_name'],
        [{ phone: good }, 'invalid_display_name'],
        [{ display_name: '\t', phone: 'bad' }, 'invalid_phone'], // trim is spaces only
        [{ display_name: 'A', phone: good.slice(1) }, 'invalid_phone'], // no `+`: strict
        [{ display_name: 'A', phone: '+0123456789' }, 'invalid_phone'],
        [{ display_name: 'A', phone: '+1234567' }, 'invalid_phone'], // 7 digits
        [{ display_name: 'A', phone: '+1234567890123456' }, 'invalid_phone'], // 16 digits
        [{ display_name: 'A', phone: `${good}\n` }, 'invalid_phone'],
        [{ display_name: 'A', phone: `\t${good}` }, 'invalid_phone'],
        [{ display_name: 'A', phone: good, relationship: 'cousin' }, 'invalid_relationship'],
        [{ display_name: 'A', phone: good, relationship: 'Friend' }, 'invalid_relationship'],
      ];
      for (const [body, code] of cases) {
        const reply = await invitePhone(app, owner.id, body);
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply).code).toBe(`invite_circle_member_by_phone:${code}`);
        expect(
          await sqlCode(owner, 'public.invite_circle_member_by_phone($1, $2, $3)', [
            body.display_name ?? null,
            body.phone ?? null,
            body.relationship ?? null,
          ]),
        ).toBe(`invite_circle_member_by_phone:${code}`);
      }
    });

    it('blank relationship is none; a value the body cannot carry as text is 422 on its field', async () => {
      const { owner } = await ownerWithCircle();
      const reply = await invitePhone(app, owner.id, {
        display_name: 'Rel Blank',
        phone: invitePhoneNumber(),
        relationship: '   ',
      });
      expect(reply.statusCode).toBe(201);
      expect(reply.json<Body>().relationship).toBeNull();
      for (const [body, field] of [
        [[1, 2], 'body'],
        [{ display_name: 5, phone: invitePhoneNumber() }, 'display_name'],
        [{ display_name: 'A', phone: 12015550100 }, 'phone'],
        [{ display_name: 'A', phone: invitePhoneNumber(), relationship: true }, 'relationship'],
        [{ display_name: 'A\u0000', phone: invitePhoneNumber() }, 'display_name'],
      ] as Array<[unknown, string]>) {
        const bad = await invitePhone(app, owner.id, body);
        expect(bad.statusCode).toBe(422);
        expect(errorOf(bad)).toMatchObject({
          code: 'validation:invalid_request',
          details: { field },
        });
      }
    });

    it('same number while pending: 200 refresh of the same row (resent, new token, no new slot); the old token is gone', async () => {
      const { owner } = await ownerWithCircle();
      const claimer = await createUser(client);
      const phone = invitePhoneNumber();
      const first = (
        await invitePhone(app, owner.id, {
          display_name: 'First Name',
          phone,
          relationship: 'parent',
        })
      ).json<Body>();
      // A claimed invite (preview/list set user_id) is unclaimed by the refresh.
      await client.query('update public.safety_circle_members set user_id = $2 where id = $1', [
        first.member_id,
        claimer.id,
      ]);
      const capBefore = await capacityOf(owner);
      const reply = await invitePhone(app, owner.id, { display_name: 'Second Name', phone });
      expect(reply.statusCode).toBe(200);
      const second = reply.json<Body>();
      expectPayload(second);
      expect(second).toMatchObject({
        member_id: first.member_id,
        display_name: 'Second Name',
        relationship: 'parent', // kept when the argument is null
        phone,
        resent: true,
      });
      expect(second.invite_token).not.toBe(first.invite_token);
      expect(await lookup(first.invite_token as string)).toBe('not_found');
      expect(await lookup(second.invite_token as string)).toBe('pending');
      expect(await capacityOf(owner)).toEqual(capBefore);
      expect(await rowOf(first.member_id as string)).toMatchObject({ user_id: null });
      expect((await auditRows(first.member_id as string)).map((r) => r.action)).toEqual([
        'circle.invite.created',
        'circle.invite.resent',
      ]);
      expect((await auditRows(first.member_id as string))[1].detail).toEqual({
        circle_id: first.circle_id,
        channel: 'phone',
        previous_status: 'pending',
      });
    });

    it('active or consumed row of that phone: 409 already_active, nothing written', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ben = await createUser(client, { phone: true });
      await addActiveMember(client, circle, ben);
      const consumedPhone = invitePhoneNumber();
      const consumedId = await insertRow(circle, { phone: consumedPhone, consumed: true });
      for (const phone of [ben.phone as string, consumedPhone]) {
        const reply = await invitePhone(app, owner.id, { display_name: 'X', phone });
        expect(reply.statusCode).toBe(409);
        expect(errorOf(reply).code).toBe('invite_circle_member_by_phone:already_active');
      }
      expect((await rowOf(consumedId)).display_name).toBe('Row Name');
    });

    it('expired or declined row: refreshed only with a free slot (else 409 circle_full, no write)', async () => {
      const { owner, circle } = await ownerWithCircle();
      const expiredPhone = invitePhoneNumber();
      const declinedPhone = invitePhoneNumber();
      const expiredId = await insertExpired(circle, { phone: expiredPhone, name: 'Old' });
      const declinedId = await insertRow(circle, {
        phone: declinedPhone,
        status: 'declined',
        canceled: true,
      });
      await fillPending(circle, 5);
      const before = await rowOf(expiredId);
      for (const phone of [expiredPhone, declinedPhone]) {
        const reply = await invitePhone(app, owner.id, { display_name: 'Again', phone });
        expect(reply.statusCode).toBe(409);
        expect(errorOf(reply).code).toBe('invite_circle_member_by_phone:circle_full');
      }
      expect(await rowOf(expiredId)).toEqual(before);
      expect((await rowOf(declinedId)).status).toBe('declined');

      // Free two slots: both refresh into valid pending rows (same ids).
      await client.query(
        `update public.safety_circle_members set status = 'declined', invite_canceled_at = now()
          where circle_id = $1 and display_name in ('Filler 0', 'Filler 1')`,
        [circle.id],
      );
      for (const [phone, id] of [
        [expiredPhone, expiredId],
        [declinedPhone, declinedId],
      ]) {
        const reply = await invitePhone(app, owner.id, { display_name: 'Again', phone });
        expect(reply.statusCode).toBe(200);
        expect(reply.json<Body>()).toMatchObject({ member_id: id, resent: true });
        expect(await rowOf(id)).toMatchObject({
          status: 'pending',
          invite_canceled_at: null,
          invite_consumed_at: null,
          seven_days: true,
        });
      }
      expect(await capacityOf(owner)).toMatchObject({ used: 5, available: 0 });
    });

    it('no row and no slot: 409 circle_full and no row; expired rows hold no slot', async () => {
      const { owner, circle } = await ownerWithCircle();
      await fillPending(circle, 5);
      await insertExpired(circle);
      const count = await rowCount(circle);
      const reply = await invitePhone(app, owner.id, {
        display_name: 'Late',
        phone: invitePhoneNumber(),
      });
      expect(reply.statusCode).toBe(409);
      expect(errorOf(reply).code).toBe('invite_circle_member_by_phone:circle_full');
      expect(await rowCount(circle)).toBe(count);

      const { owner: owner2, circle: circle2 } = await ownerWithCircle();
      await fillPending(circle2, 4);
      await insertExpired(circle2);
      await insertExpired(circle2);
      const ok = await invitePhone(app, owner2.id, {
        display_name: 'Fits',
        phone: invitePhoneNumber(),
      });
      expect(ok.statusCode).toBe(201);
    });

    it('Idempotency-Key: a retry replays the stored response and writes nothing', async () => {
      const { owner, circle } = await ownerWithCircle();
      const key = randomUUID();
      const body = { display_name: 'Idem', phone: invitePhoneNumber() };
      const first = await invitePhone(app, owner.id, body, { idempotencyKey: key });
      const replay = await invitePhone(app, owner.id, body, { idempotencyKey: key });
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toBe(first.body);
      const row = await rowOf(first.json<Body>().member_id as string);
      expect(row.invite_token).toBe(first.json<Body>().invite_token);
      expect(await rowCount(circle)).toBe(2);
      const other = await invitePhone(
        app,
        owner.id,
        { ...body, display_name: 'Other' },
        {
          idempotencyKey: key,
        },
      );
      expect(other.statusCode).toBe(422);
      expect(errorOf(other).code).toBe('idempotency:key_mismatch');
    });
  });

  // --- API-100-26 AC5: batch ---------------------------------------------------------------------

  describe('POST /v1/me/circle/invites/phone/batch', () => {
    it('422 invalid_invites when `invites` is not an array (missing, null, object, string), as SQL', async () => {
      const { owner } = await ownerWithCircle();
      for (const invites of [undefined, null, {}, 'x', 5]) {
        const reply = await inviteBatch(app, owner.id, invites === undefined ? {} : { invites });
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply).code).toBe('invite_circle_members_by_phone:invalid_invites');
      }
      expect(await sqlCode(owner, 'public.invite_circle_members_by_phone(null)')).toBe(
        'invite_circle_members_by_phone:invalid_invites',
      );
      const notObject = await inviteBatch(app, owner.id, [1]);
      expect(errorOf(notObject)).toMatchObject({ details: { field: 'body' } });
    });

    it('mixed outcomes in array order, normalization, available_after, one row per phone', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ben = await createUser(client, { phone: true });
      await addActiveMember(client, circle, ben);
      const pendingPhone = invitePhoneNumber();
      const pendingId = await insertRow(circle, { phone: pendingPhone });
      const expiredPhone = invitePhoneNumber();
      const expiredId = await insertExpired(circle, { phone: expiredPhone, relationship: 'child' });
      const newA = invitePhoneNumber();
      const newB = invitePhoneNumber();
      const newC = invitePhoneNumber();
      // Used: Ben + pending = 2, so 3 free.
      const reply = await inviteBatch(app, owner.id, {
        invites: [
          5,
          null,
          ['x'],
          { phone: 'not a phone', display_name: '  Bad Phone ' },
          { phone: '   ', display_name: '   ' },
          { display_name: 'No Phone' },
          { phone: newA, display_name: '   ' },
          { phone: ben.phone, display_name: 'Ben Again' },
          { phone: ` ${pendingPhone} `, display_name: 'Still Pending' },
          { phone: expiredPhone, display_name: ' Expired Back ' },
          { phone: newA.slice(1), display_name: 'New A' }, // digits only → +E.164
          { phone: newA, display_name: 'New A Twice' },
          { phone: newB, display_name: 'New B', relationship: 'friend' },
          { phone: newC, display_name: 'New C' },
        ],
      });
      expect(reply.statusCode).toBe(200);
      const body = reply.json<{
        created: Body[];
        skipped: Body[];
        not_created: Body[];
        available_after: number;
      }>();
      expect(Object.keys(body)).toEqual(['created', 'skipped', 'not_created', 'available_after']);
      expect(body.not_created).toEqual([
        { phone: null, reason: 'invalid_invite', display_name: null },
        { phone: null, reason: 'invalid_invite', display_name: null },
        { phone: null, reason: 'invalid_invite', display_name: null },
        { phone: 'not a phone', reason: 'invalid_phone', display_name: 'Bad Phone' },
        { phone: null, reason: 'invalid_phone', display_name: null },
        { phone: null, reason: 'invalid_phone', display_name: 'No Phone' },
        { phone: newA, reason: 'invalid_display_name', display_name: null },
        { phone: newC, reason: 'circle_full', display_name: 'New C' },
      ]);
      expect(body.skipped).toEqual([
        {
          phone: ben.phone,
          reason: 'already_active',
          member_id: expect.any(String) as unknown,
          display_name: 'Ben Again',
        },
        {
          phone: pendingPhone,
          reason: 'already_pending',
          member_id: pendingId,
          display_name: 'Still Pending',
        },
        {
          phone: newA,
          reason: 'already_pending',
          member_id: body.created[1].member_id,
          display_name: 'New A Twice',
        },
      ]);
      expect(body.created.map((c) => [c.phone, c.display_name, c.relationship, c.resent])).toEqual([
        [expiredPhone, 'Expired Back', 'child', true],
        [newA, 'New A', null, false],
        [newB, 'New B', null, false], // batch items carry no relationship
      ]);
      body.created.forEach(expectPayload);
      expect(body.created[0].member_id).toBe(expiredId);
      expect(body.available_after).toBe(0);
      expect(await capacityOf(owner)).toMatchObject({ used: 5, available: 0 });
      // Skipped rows are untouched; nothing else was written.
      expect((await rowOf(pendingId)).display_name).toBe('Row Name');
      expect(await rowCount(circle)).toBe(1 + 1 + 1 + 1 + 2);
    });

    it('an empty array is a no-op that reports the free slots', async () => {
      const { owner } = await ownerWithCircle();
      const reply = await inviteBatch(app, owner.id, { invites: [] });
      expect(reply.json()).toEqual({
        created: [],
        skipped: [],
        not_created: [],
        available_after: 5,
      });
    });
  });

  // --- API-100-27: link --------------------------------------------------------------------------

  describe('POST /v1/me/circle/invites/link', () => {
    it("201 pending row without a phone; missing, null or blank name → 'Invited member'; trimmed otherwise", async () => {
      const { owner, circle } = await ownerWithCircle();
      const names: Array<[unknown, string]> = [
        [undefined, 'Invited member'],
        [{}, 'Invited member'],
        [{ display_name: null }, 'Invited member'],
        [{ display_name: '    ' }, 'Invited member'],
        [{ display_name: '  Cara Link  ' }, 'Cara Link'],
      ];
      for (const [body, name] of names) {
        const reply = await createInviteLink(app, owner.id, body);
        expect(reply.statusCode).toBe(201);
        const payload = reply.json<Body>();
        expectPayload(payload);
        expect(payload).toMatchObject({
          circle_id: circle.id,
          display_name: name,
          phone: null,
          relationship: null,
          resent: false,
        });
        expect(await rowOf(payload.member_id as string)).toMatchObject({
          status: 'pending',
          phone: null,
          user_id: null,
          activated_at: null,
        });
        expect((await auditRows(payload.member_id as string))[0]).toMatchObject({
          action: 'circle.invite.created',
          detail: { circle_id: circle.id, channel: 'link' },
        });
      }
      const bad = await createInviteLink(app, owner.id, { display_name: 7 });
      expect(errorOf(bad)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'display_name' },
      });
    });

    it('409 circle_full at 5/5 with no row left behind; each call reserves a slot; Idempotency-Key makes a retry safe', async () => {
      const { owner, circle } = await ownerWithCircle();
      await fillPending(circle, 3);
      const key = randomUUID();
      const first = await createInviteLink(app, owner.id, {}, { idempotencyKey: key });
      const replay = await createInviteLink(app, owner.id, {}, { idempotencyKey: key });
      expect(replay.body).toBe(first.body);
      expect(await capacityOf(owner)).toMatchObject({ used: 4 });
      expect((await createInviteLink(app, owner.id, {})).statusCode).toBe(201);
      const count = await rowCount(circle);
      const full = await createInviteLink(app, owner.id, {});
      expect(full.statusCode).toBe(409);
      expect(errorOf(full).code).toBe('create_circle_invite_link:circle_full');
      expect(await rowCount(circle)).toBe(count);
    });
  });

  // --- API-100-28 AC1: resend --------------------------------------------------------------------

  describe('POST /v1/me/circle/invites/{member_id}/resend', () => {
    it('errors in the SQL order with its codes', async () => {
      const { owner, circle } = await ownerWithCircle();
      const other = await ownerWithCircle('Other Owner');
      const foreign = await insertRow(other.circle);
      const ben = await createUser(client);
      const active = await addActiveMember(client, circle, ben);
      const consumed = await insertRow(circle, { consumed: true });
      const cases: Array<[string, number, string]> = [
        [randomUUID(), 404, 'member_not_found'],
        [foreign, 404, 'member_not_found'],
        [circle.ownerMemberId, 409, 'not_invitable'],
        [active.id, 409, 'already_active'],
        [consumed, 409, 'already_active'],
      ];
      for (const [id, status, code] of cases) {
        const reply = await resendInvite(app, owner.id, id);
        expect(reply.statusCode).toBe(status);
        expect(errorOf(reply).code).toBe(`resend_circle_invite:${code}`);
        expect(await sqlCode(owner, 'public.resend_circle_invite($1)', [id])).toBe(
          `resend_circle_invite:${code}`,
        );
      }
      expect(await sqlCode(owner, 'public.resend_circle_invite(null)')).toBe(
        'resend_circle_invite:member_not_found',
      );
      for (const bad of ['null', 'not-a-uuid']) {
        const reply = await resendInvite(app, owner.id, bad);
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply)).toMatchObject({ details: { field: 'member_id' } });
      }
    });

    it('valid pending at 5/5: 200, same row, new token (old one not_found), no new slot', async () => {
      const { owner, circle } = await ownerWithCircle();
      await fillPending(circle, 4);
      const id = await insertRow(circle, { name: 'Five', relationship: 'other', phone: null });
      const before = await rowOf(id);
      const reply = await resendInvite(app, owner.id, id);
      expect(reply.statusCode).toBe(200);
      const body = reply.json<Body>();
      expectPayload(body);
      expect(body).toMatchObject({
        member_id: id,
        display_name: 'Five',
        relationship: 'other',
        resent: true,
      });
      expect(await lookup(before.invite_token as string)).toBe('not_found');
      expect(await capacityOf(owner)).toMatchObject({ used: 5, available: 0 });
      expect((await auditRows(id))[0]).toMatchObject({
        action: 'circle.invite.resent',
        detail: { circle_id: circle.id, channel: 'resend', previous_status: 'pending' },
      });
    });

    it('expired or declined: 409 circle_full at 5/5 with no write; with a free slot a new 7-day token', async () => {
      const { owner, circle } = await ownerWithCircle();
      const expired = await insertExpired(circle, { name: 'Expired One' });
      const declined = await insertRow(circle, { status: 'declined', canceled: true });
      await fillPending(circle, 5);
      for (const id of [expired, declined]) {
        const before = await rowOf(id);
        const reply = await resendInvite(app, owner.id, id);
        expect(reply.statusCode).toBe(409);
        expect(errorOf(reply).code).toBe('resend_circle_invite:circle_full');
        expect(await rowOf(id)).toEqual(before);
      }
      await client.query(
        `update public.safety_circle_members set status = 'declined', invite_canceled_at = now()
          where circle_id = $1 and display_name like 'Filler%'`,
        [circle.id],
      );
      for (const id of [expired, declined]) {
        const before = await rowOf(id);
        const body = (await resendInvite(app, owner.id, id)).json<Body>();
        expect(body).toMatchObject({ member_id: id, resent: true, status: 'pending' });
        expect(await lookup(before.invite_token as string)).toBe('not_found');
        expect(await lookup(body.invite_token as string)).toBe('pending');
        expect(await rowOf(id)).toMatchObject({
          invite_canceled_at: null,
          invite_consumed_at: null,
          user_id: null,
          seven_days: true,
        });
      }
    });

    it('needs location sharing (409 location_sharing_disabled)', async () => {
      const { owner, circle } = await ownerWithCircle();
      const id = await insertRow(circle);
      await client.query(
        'update public.profiles set location_sharing_enabled = false where id = $1',
        [owner.id],
      );
      const reply = await resendInvite(app, owner.id, id);
      expect(reply.statusCode).toBe(409);
      expect(errorOf(reply).code).toBe('resend_circle_invite:location_sharing_disabled');
    });
  });

  // --- API-100-28 AC2/AC3: cancel ----------------------------------------------------------------

  describe('POST /v1/me/circle/invites/{member_id}/cancel', () => {
    it('errors in the SQL order with its codes; never cancel_circle_invite:expired', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ben = await createUser(client);
      const active = await addActiveMember(client, circle, ben);
      const declined = await insertRow(circle, { status: 'declined', canceled: true });
      const consumed = await insertRow(circle, { consumed: true });
      const pending = await insertRow(circle);
      const outsider = await ownerWithCircle('Outsider');
      const cases: Array<[UserFixture, string, number, string]> = [
        [owner, randomUUID(), 404, 'not_found'],
        [outsider.owner, pending, 403, 'not_authorized'],
        [ben, pending, 403, 'not_authorized'], // an active member is not the owner
        [owner, circle.ownerMemberId, 409, 'cannot_cancel_owner'],
        [owner, active.id, 409, 'not_pending'],
        [owner, declined, 409, 'not_pending'],
        [owner, consumed, 409, 'not_pending'],
      ];
      for (const [user, id, status, code] of cases) {
        const before = await rowOf(id);
        const reply = await cancelInvite(app, user.id, id);
        expect(reply.statusCode).toBe(status);
        expect(errorOf(reply).code).toBe(`cancel_circle_invite:${code}`);
        expect(await sqlCode(user, 'public.cancel_circle_invite($1)', [id])).toBe(
          `cancel_circle_invite:${code}`,
        );
        expect(await rowOf(id)).toEqual(before);
      }
      expect(await sqlCode(owner, 'public.cancel_circle_invite(null)')).toBe(
        'cancel_circle_invite:not_found',
      );
      const nullPath = await cancelInvite(app, owner.id, 'null');
      expect(nullPath.statusCode).toBe(422);
      expect(errorOf(nullPath)).toMatchObject({ details: { field: 'member_id' } });
    });

    it('pending: 200 canceled, declined + canceled_at, slot freed, token canceled; owner_name is the stored owner row name', async () => {
      const { owner, circle } = await ownerWithCircle('Ada Profile');
      await client.query(
        "update public.safety_circle_members set display_name = 'Ada Stored' where id = $1",
        [circle.ownerMemberId],
      );
      const id = await insertRow(circle);
      const before = await rowOf(id);
      expect((await capacityOf(owner)).used).toBe(1);
      const reply = await cancelInvite(app, owner.id, id);
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe(
        JSON.stringify({
          status: 'canceled',
          circle_id: circle.id,
          member_id: id,
          owner_name: 'Ada Stored',
        }),
      );
      expect(await rowOf(id)).toMatchObject({
        status: 'declined',
        invite_token: before.invite_token,
        invite_consumed_at: null,
        activated_at: null,
      });
      expect((await rowOf(id)).invite_canceled_at).not.toBeNull();
      expect(await lookup(before.invite_token as string)).toBe('canceled');
      expect((await capacityOf(owner)).used).toBe(0);
      expect(await auditRows(id)).toEqual([
        {
          action: 'circle.invite.canceled',
          target_type: 'circle_member',
          actor: owner.id,
          detail: { circle_id: circle.id, previous_status: 'pending' },
        },
      ]);
      const again = await cancelInvite(app, owner.id, id);
      expect(errorOf(again).code).toBe('cancel_circle_invite:not_pending');
    });

    it('expired: 200 canceled, frees no slot; works with location sharing off (no check)', async () => {
      const { owner, circle } = await ownerWithCircle();
      await fillPending(circle, 5);
      const expired = await insertExpired(circle);
      await client.query(
        'update public.profiles set location_sharing_enabled = false where id = $1',
        [owner.id],
      );
      const reply = await cancelInvite(app, owner.id, expired);
      expect(reply.statusCode).toBe(200);
      expect(reply.json<Body>().status).toBe('canceled');
      expect(await rowOf(expired)).toMatchObject({ status: 'declined' });
      expect(await capacityOf(owner)).toMatchObject({ used: 5, available: 0 });
      expect((await auditRows(expired))[0].detail).toMatchObject({ previous_status: 'expired' });
    });
  });

  // --- Interchangeability with the SQL functions -------------------------------------------------

  describe('same state and caller → same JSON, rows and codes as the SQL function', () => {
    type Reply = Awaited<ReturnType<typeof invitePhone>>;
    /**
     * Every row of the circle, comparable across the two sides: ids, values, and whether the call
     * wrote the timestamps (`invited_at`/`updated_at` at or after `cutoff`, taken just before it).
     */
    const circleRows = (circleId: string, cutoff: string) => ({
      statement: `select m.id::text as id, m.role, m.status, m.display_name, m.relationship,
          m.phone, m.email, m.user_id, m.invite_token is not null as has_token,
          m.invite_consumed_at is null as not_consumed,
          m.invite_canceled_at is null as not_canceled,
          m.invite_canceled_at >= $2::timestamptz as canceled_now,
          m.activated_at is null as not_activated,
          (m.invite_expires_at - m.invited_at) = interval '7 days' as seven_days,
          m.invited_at >= $2::timestamptz as invited_now,
          m.updated_at >= $2::timestamptz as updated_now
        from public.safety_circle_members m
       where m.circle_id = $1
       order by m.created_at, m.display_name, m.status`,
      params: [circleId, cutoff],
    });
    const clock = async () =>
      (await client.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0].t;

    /** Tokens, times and ids of new rows replaced, keeping key order (JSON text compared). */
    const normalize = (value: unknown, ids: Map<string, string>): unknown => {
      if (Array.isArray(value)) return value.map((v) => normalize(v, ids));
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, v]) => {
            if (key === 'invite_token' || key === 'invite_url') return [key, '<token>'];
            if (key === 'invited_at' || key === 'invite_expires_at') return [key, '<time>'];
            if (key === 'member_id' && typeof v === 'string') {
              if (!ids.has(v)) ids.set(v, `<new${ids.size}>`);
              return [key, ids.get(v)];
            }
            return [key, normalize(v, ids)];
          }),
        );
      }
      return value;
    };

    const compare = async (
      owned: Owned,
      caller: UserFixture,
      sqlCall: string,
      params: unknown[],
      api: () => Promise<Reply>,
      keepIds: string[],
    ) => {
      const cutoff = await clock();
      const rows = circleRows(owned.circle.id, cutoff);
      const sqlSide = await sqlRolledBack<Body, Body>(client, caller.id, sqlCall, params, rows);
      const reply = await api();
      const known = () => new Map(keepIds.map((id) => [id, id]));
      if (sqlSide.error) {
        expect(reply.statusCode).toBeGreaterThanOrEqual(400);
        expect(errorOf(reply).code).toBe(sqlSide.error);
      } else {
        expect(reply.statusCode).toBeLessThan(300);
        expect(JSON.stringify(normalize(JSON.parse(reply.body), known()))).toBe(
          JSON.stringify(normalize(sqlSide.body, known())),
        );
      }
      const strip = (rows: Body[]) =>
        normalize(
          rows.map(({ id, ...rest }) => ({ member_id: id, ...rest })),
          known(),
        );
      expect(sqlSide.rows?.length).toBeGreaterThanOrEqual(5);
      const after = (await client.query<Body>(rows.statement, rows.params)).rows;
      expect(strip(after)).toEqual(strip(sqlSide.rows ?? []));
    };

    /** A circle with every row state of a phone: active, valid pending, expired, declined. */
    const richCircle = async () => {
      const owned = await ownerWithCircle();
      const ben = await createUser(client, { phone: true });
      const active = await addActiveMember(client, owned.circle, ben);
      const phones = {
        active: ben.phone as string,
        pending: invitePhoneNumber(),
        expired: invitePhoneNumber(),
        declined: invitePhoneNumber(),
      };
      const ids = {
        owner: owned.circle.ownerMemberId,
        active: active.id,
        pending: await insertRow(owned.circle, { phone: phones.pending, name: 'P' }),
        expired: await insertExpired(owned.circle, { phone: phones.expired, name: 'E' }),
        declined: await insertRow(owned.circle, {
          phone: phones.declined,
          name: 'D',
          status: 'declined',
          canceled: true,
        }),
      };
      return { owned, phones, ids, keep: Object.values(ids) };
    };

    it('invite_circle_member_by_phone: new, refresh of pending / expired / declined, already_active', async () => {
      for (const target of ['new', 'pending', 'expired', 'declined', 'active'] as const) {
        const { owned, phones, keep } = await richCircle();
        const phone = target === 'new' ? invitePhoneNumber() : phones[target];
        await compare(
          owned,
          owned.owner,
          'public.invite_circle_member_by_phone($1, $2, $3)',
          [' Name X ', phone, null],
          () => invitePhone(app, owned.owner.id, { display_name: ' Name X ', phone }),
          keep,
        );
      }
    });

    it('invite_circle_member_by_phone at 5/5 for an expired row: circle_full on both', async () => {
      const { owned, phones, keep } = await richCircle();
      await fillPending(owned.circle, 3);
      await compare(
        owned,
        owned.owner,
        'public.invite_circle_member_by_phone($1, $2, $3)',
        ['Full', phones.expired, 'friend'],
        () =>
          invitePhone(app, owned.owner.id, {
            display_name: 'Full',
            phone: phones.expired,
            relationship: 'friend',
          }),
        keep,
      );
    });

    it('invite_circle_members_by_phone: a mixed batch', async () => {
      const { owned, phones, keep } = await richCircle();
      const fresh = invitePhoneNumber();
      const invites = [
        { phone: phones.active, display_name: 'A' },
        { phone: phones.pending, display_name: 'B' },
        { phone: phones.expired, display_name: 'C' },
        { phone: fresh.slice(1), display_name: 'D' },
        { phone: fresh, display_name: 'E' },
        { phone: phones.declined, display_name: 'F' },
        { phone: invitePhoneNumber(), display_name: 'G' },
        { phone: 'nope', display_name: ' ' },
        { phone: invitePhoneNumber(), display_name: ' ' },
        'x',
      ];
      await compare(
        owned,
        owned.owner,
        'public.invite_circle_members_by_phone($1::jsonb)',
        [JSON.stringify(invites)],
        () => inviteBatch(app, owned.owner.id, { invites }),
        keep,
      );
    });

    it('create_circle_invite_link: named, unnamed, and at 5/5', async () => {
      for (const name of ['  Named  ', null]) {
        const { owned, keep } = await richCircle();
        await compare(
          owned,
          owned.owner,
          'public.create_circle_invite_link($1)',
          [name],
          () => createInviteLink(app, owned.owner.id, { display_name: name }),
          keep,
        );
      }
      const { owned, keep } = await richCircle();
      await fillPending(owned.circle, 3);
      await compare(
        owned,
        owned.owner,
        'public.create_circle_invite_link(null)',
        [],
        () => createInviteLink(app, owned.owner.id, {}),
        keep,
      );
    });

    it('resend_circle_invite: every row state, and expired at 5/5', async () => {
      for (const target of ['owner', 'active', 'pending', 'expired', 'declined'] as const) {
        const { owned, ids, keep } = await richCircle();
        await compare(
          owned,
          owned.owner,
          'public.resend_circle_invite($1)',
          [ids[target]],
          () => resendInvite(app, owned.owner.id, ids[target]),
          keep,
        );
      }
      const { owned, ids, keep } = await richCircle();
      await fillPending(owned.circle, 3);
      await compare(
        owned,
        owned.owner,
        'public.resend_circle_invite($1)',
        [ids.expired],
        () => resendInvite(app, owned.owner.id, ids.expired),
        keep,
      );
    });

    it('cancel_circle_invite: every row state, and a non-owner caller', async () => {
      for (const target of ['owner', 'active', 'pending', 'expired', 'declined'] as const) {
        const { owned, ids, keep } = await richCircle();
        await compare(
          owned,
          owned.owner,
          'public.cancel_circle_invite($1)',
          [ids[target]],
          () => cancelInvite(app, owned.owner.id, ids[target]),
          keep,
        );
      }
      const { owned, ids, keep } = await richCircle();
      const outsider = await createUser(client);
      await compare(
        owned,
        outsider,
        'public.cancel_circle_invite($1)',
        [ids.pending],
        () => cancelInvite(app, outsider.id, ids.pending),
        keep,
      );
    });

    it('the SQL functions and the API can follow each other on the same rows', async () => {
      const { owned, phones, ids } = await richCircle();
      // SQL refreshes, API cancels, SQL resends, API refreshes by phone.
      const viaSql = await sqlAs<Body>(
        client,
        owned.owner.id,
        'public.invite_circle_member_by_phone($1, $2, null)',
        ['Mixed', phones.pending],
      );
      expect(viaSql.member_id).toBe(ids.pending);
      expect((await cancelInvite(app, owned.owner.id, ids.pending)).statusCode).toBe(200);
      const resent = await sqlAs<Body>(client, owned.owner.id, 'public.resend_circle_invite($1)', [
        ids.pending,
      ]);
      expect(resent.resent).toBe(true);
      const again = await invitePhone(app, owned.owner.id, {
        display_name: 'Mixed Again',
        phone: phones.pending,
      });
      expect(again.statusCode).toBe(200);
      expect(again.json<Body>()).toMatchObject({ member_id: ids.pending, resent: true });
      expect(await lookup(resent.invite_token as string)).toBe('not_found');
    });
  });

  // --- Known bypass (spec §4.4) stays closed ----------------------------------------------------

  describe('no route of this round creates or updates a member row to active', () => {
    it('hostile bodies on every route leave active rows and activated_at exactly as they were', async () => {
      const { owned, phones, ids } = await (async () => {
        const o = await ownerWithCircle();
        const ben = await createUser(client, { phone: true });
        const active = await addActiveMember(client, o.circle, ben);
        const p = { pending: invitePhoneNumber(), expired: invitePhoneNumber() };
        return {
          owned: o,
          phones: p,
          ids: {
            active: active.id,
            pending: await insertRow(o.circle, { phone: p.pending }),
            expired: await insertExpired(o.circle, { phone: p.expired }),
            declined: await insertRow(o.circle, { status: 'declined', canceled: true }),
          },
        };
      })();
      const hostile = {
        status: 'active',
        role: 'owner',
        user_id: owned.owner.id,
        activated_at: '2000-01-01T00:00:00Z',
        invite_consumed_at: '2000-01-01T00:00:00Z',
      };
      const activeRows = async () =>
        (
          await client.query<Body>(
            `select id::text, status, role, activated_at from public.safety_circle_members
              where circle_id = $1 and (status = 'active' or activated_at is not null)
              order by id`,
            [owned.circle.id],
          )
        ).rows;
      const before = await activeRows();

      // Used: active + pending = 2. Each step keeps within the 5 slots.
      const replies = [
        await invitePhone(app, owned.owner.id, {
          ...hostile,
          display_name: 'H',
          phone: invitePhoneNumber(),
        }), // 3
        await invitePhone(app, owned.owner.id, {
          ...hostile,
          display_name: 'H',
          phone: phones.pending,
        }), // 3 (refresh)
        await invitePhone(app, owned.owner.id, {
          ...hostile,
          display_name: 'H',
          phone: phones.expired,
        }), // 4
        await inviteBatch(app, owned.owner.id, {
          ...hostile,
          invites: [{ ...hostile, phone: invitePhoneNumber(), display_name: 'H' }],
        }), // 5
        await cancelInvite(app, owned.owner.id, ids.pending), // 4
      ];
      const link = await createInviteLink(app, owned.owner.id, { ...hostile, display_name: 'H' });
      replies.push(link); // 5
      replies.push(await cancelInvite(app, owned.owner.id, link.json<Body>().member_id as string));
      replies.push(await resendInvite(app, owned.owner.id, ids.declined)); // 5
      for (const reply of replies) expect(reply.statusCode).toBeLessThan(300);
      // Resend and cancel on an active row are refused.
      expect((await resendInvite(app, owned.owner.id, ids.active)).statusCode).toBe(409);
      expect((await cancelInvite(app, owned.owner.id, ids.active)).statusCode).toBe(409);

      expect(await activeRows()).toEqual(before);
      const written = (
        await client.query<{ status: string; user_id: string | null; role: string }>(
          `select status, user_id, role from public.safety_circle_members
            where circle_id = $1 and role = 'member' and id <> $2`,
          [owned.circle.id, ids.active],
        )
      ).rows;
      for (const row of written) {
        expect(['pending', 'declined']).toContain(row.status);
        expect(row.user_id).toBeNull();
        expect(row.role).toBe('member');
      }
    });
  });
});
