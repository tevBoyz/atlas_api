import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  errorOf,
  listJoinedCircles,
  listMyInvites,
  sqlAs,
  sqlRolledBack,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import {
  compareWithSql,
  insertExpiredMember,
  insertMember,
  memberRow,
  withoutJoinedApiFields,
  withoutOwnerAvatarUrl,
} from '../support/invite-rows';

/**
 * API-100-31: `GET /v1/me/invites` (`list_my_circle_invites`, spec §7.3, §11.3 I10) and
 * `GET /v1/me/joined-circles` (`list_my_joined_circles`, C6): every acceptance criterion, the row
 * selection (claimed rows, unclaimed rows of the caller's normalized Auth phone), the statuses and
 * token rule, the claim side effect (skips, swallowed clashes, no activation), ordering, keys, and
 * the same JSON text and row changes as the SQL function for the same state and caller.
 */
type Body = Record<string, unknown>;

/** The SQL function's 7 keys plus SCRUM-33's additive `owner_avatar_url` (D46). */
const INVITE_KEYS = [
  'circle_id',
  'invite_expires_at',
  'invite_token',
  'invited_at',
  'member_id',
  'owner_avatar_url',
  'owner_name',
  'status',
];
/** The SQL function's 8 keys plus the additive `active_incident_id` (D45) and `capacity_used` (D50). */
const JOINED_KEYS = [
  'active_incident_id',
  'active_member_count',
  'capacity_used',
  'circle_id',
  'joined_at',
  'member_id',
  'name',
  'owner_name',
  'role',
  'status',
];

/** The hosted project origin the avatar URLs are built from (config `SUPABASE_URL`). */
const PROJECT_HOST = 'example-project.supabase.co';

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(400 + counter++).padStart(3, '0')}`;

describe('incoming invitations and joined circles (API-100-31)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        SUPABASE_URL: `https://${PROJECT_HOST}/`,
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
      }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  const ownerWithCircle = async (
    fullName = 'Owner Name',
  ): Promise<{ owner: UserFixture; circle: CircleFixture }> => {
    const owner = await createUser(client, { fullName, phone: phoneNumber() });
    return { owner, circle: await createCircle(client, owner) };
  };
  /** `updated_at` (= `joined_at`) set to `value`: the updated_at trigger is off for this write. */
  const setUpdatedAt = async (ids: string[], value: string) => {
    await client.query('begin');
    try {
      await client.query(
        'alter table public.safety_circle_members disable trigger safety_circle_members_set_updated_at',
      );
      await client.query(
        `update public.safety_circle_members set updated_at = ${value} where id = any($1)`,
        [ids],
      );
      await client.query(
        'alter table public.safety_circle_members enable trigger safety_circle_members_set_updated_at',
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };
  const invitesOf = async (user: UserFixture) => {
    const reply = await listMyInvites(app, user.id);
    expect(reply.statusCode).toBe(200);
    return reply.json<Body[]>();
  };
  const compareList = (caller: UserFixture, circleIds: string[]) =>
    compareWithSql(client, {
      callerId: caller.id,
      sqlCall: 'public.list_my_circle_invites()',
      params: [],
      circleIds,
      api: () => listMyInvites(app, caller.id),
      apiOnlyFields: withoutOwnerAvatarUrl,
    });
  const compareJoined = (caller: UserFixture, circleIds: string[]) =>
    compareWithSql(client, {
      callerId: caller.id,
      sqlCall: 'public.list_my_joined_circles()',
      params: [],
      circleIds,
      api: () => listJoinedCircles(app, caller.id),
      apiOnlyFields: withoutJoinedApiFields,
    });

  // --- GET /v1/me/invites -----------------------------------------------------------------------

  it('without a token: 401 list_my_circle_invites:not_authenticated', async () => {
    const reply = await listMyInvites(app, null);
    expect(reply.statusCode).toBe(401);
    expect(errorOf(reply).code).toBe('list_my_circle_invites:not_authenticated');
  });

  it('lists pending (with token, claimed), expired and canceled (no token); consumed and others excluded', async () => {
    const phone = phoneNumber();
    const invitee = await createUser(client, { fullName: 'Ivy Invitee', phone });
    const other = await createUser(client, { phone: phoneNumber() });
    const a = await ownerWithCircle('Owner A');
    const b = await ownerWithCircle('Owner B');
    const c = await ownerWithCircle('Owner C');
    const d = await ownerWithCircle('Owner D');
    const e = await ownerWithCircle('Owner E');
    const pending = await insertMember(client, a.circle.id, {
      phone,
      invitedSql: "now() - interval '1 hour'",
    });
    const expired = await insertExpiredMember(client, b.circle.id, { phone });
    const canceled = await insertMember(client, c.circle.id, {
      phone,
      status: 'declined',
      canceled: true,
      invitedSql: "now() - interval '2 hours'",
    });
    // Accepted earlier (consumed): not listed.
    const consumed = await insertMember(client, d.circle.id, {
      phone,
      status: 'active',
      userId: invitee.id,
      consumed: true,
    });
    // A link invite the invitee claimed through preview: listed (claimed rows match by user).
    const link = await insertMember(client, e.circle.id, {
      userId: invitee.id,
      invitedSql: "now() - interval '3 hours'",
    });
    // Someone else's claimed row with the invitee's phone: not the invitee's.
    const othersClaim = await insertMember(client, e.circle.id, {
      phone,
      userId: other.id,
      invitedSql: "now() - interval '4 hours'",
    });

    const listed = await invitesOf(invitee);
    expect(listed.map((x) => x.member_id)).toEqual([pending.id, canceled.id, link.id, expired.id]);
    for (const item of listed) expect(Object.keys(item).sort()).toEqual(INVITE_KEYS);
    const byId: Record<string, Body> = Object.fromEntries(
      listed.map((x) => [x.member_id as string, x]),
    );
    expect(byId[pending.id]).toMatchObject({
      status: 'pending',
      invite_token: pending.token,
      circle_id: a.circle.id,
      owner_name: 'Owner A',
    });
    expect(byId[expired.id]).toMatchObject({ status: 'expired', invite_token: null });
    expect(byId[canceled.id]).toMatchObject({ status: 'canceled', invite_token: null });
    expect(byId[link.id]).toMatchObject({ status: 'pending', invite_token: link.token });
    expect(byId[consumed.id]).toBeUndefined();
    expect(byId[othersClaim.id]).toBeUndefined();

    // The claim: the pending phone row now carries the invitee, still pending, never active.
    expect(await memberRow(client, pending.id)).toMatchObject({
      user_id: invitee.id,
      status: 'pending',
      activated_at: null,
    });
    // Not claimed: expired, canceled, someone else's.
    expect((await memberRow(client, expired.id)).user_id).toBeNull();
    expect((await memberRow(client, canceled.id)).user_id).toBeNull();
    expect((await memberRow(client, othersClaim.id)).user_id).toBe(other.id);
    // No audit row for a claim.
    const audit = await client.query('select 1 from public.audit_log where target_id = any($1)', [
      [pending.id, expired.id, canceled.id, link.id],
    ]);
    expect(audit.rowCount).toBe(0);
  });

  it('matches the Auth phone normalized (no +, spaces) and lists nothing by phone without an Auth phone', async () => {
    const phone = phoneNumber();
    const invitee = await createUser(client, { phone });
    await client.query(`update auth.users set phone = $2 where id = $1`, [
      invitee.id,
      `  ${phone.slice(1)} `,
    ]);
    const { circle } = await ownerWithCircle();
    const row = await insertMember(client, circle.id, { phone });
    expect((await invitesOf(invitee)).map((x) => x.member_id)).toEqual([row.id]);
    expect((await memberRow(client, row.id)).user_id).toBe(invitee.id);

    const noPhone = await createUser(client);
    const other = await ownerWithCircle();
    await insertMember(client, other.circle.id, { phone: phoneNumber() });
    expect(await invitesOf(noPhone)).toEqual([]);
  });

  it('does not claim where the caller is already active (own circle included), and swallows a clash', async () => {
    const phone = phoneNumber();
    const user = await createUser(client, { fullName: 'Multi', phone });
    // Already active in circle A via another row: the phone row is listed, not claimed.
    const a = await ownerWithCircle();
    await addActiveMember(client, a.circle, { ...user, phone: null });
    const inA = await insertMember(client, a.circle.id, { phone });
    // The caller's own circle: a phone row to the owner's own phone is not claimed (owner active).
    const own = await createCircle(client, user);
    const inOwn = await insertMember(client, own.id, { phone });
    // Circle B: the caller declined an earlier link invite there (user_id = caller), so claiming
    // the pending phone row clashes on (circle_id, user_id): swallowed, the row stays unclaimed.
    const b = await ownerWithCircle();
    const declined = await insertMember(client, b.circle.id, {
      status: 'declined',
      canceled: true,
      userId: user.id,
    });
    const inB = await insertMember(client, b.circle.id, { phone });

    await compareList(user, [a.circle.id, own.id, b.circle.id]);
    const listed = await invitesOf(user);
    expect(new Set(listed.map((x) => x.member_id))).toEqual(
      new Set([inA.id, inOwn.id, declined.id, inB.id]),
    );
    expect(listed.find((x) => x.member_id === inA.id)).toMatchObject({
      status: 'pending',
      invite_token: inA.token,
    });
    for (const id of [inA.id, inOwn.id, inB.id]) {
      expect((await memberRow(client, id)).user_id).toBeNull();
    }
  });

  it('is safe to repeat: a claimed row is not written again', async () => {
    const phone = phoneNumber();
    const invitee = await createUser(client, { phone });
    const { circle } = await ownerWithCircle();
    const row = await insertMember(client, circle.id, { phone });
    await invitesOf(invitee);
    const first = await memberRow(client, row.id);
    const again = await invitesOf(invitee);
    expect(again.map((x) => x.member_id)).toEqual([row.id]);
    expect((await memberRow(client, row.id)).updated_at).toEqual(first.updated_at);
  });

  it('orders as the SQL: (payload->>invited_at) desc in the database collation, then member_id for ties', async () => {
    const phone = phoneNumber();
    const invitee = await createUser(client, { phone });
    const circles = await Promise.all([1, 2, 3, 4, 5].map(() => ownerWithCircle()));
    const at = (t: string) => `timestamptz '2026-11-19 ${t}+00'`;
    const rows = [
      await insertMember(client, circles[0].circle.id, { phone, invitedSql: at('10:00:00.5') }),
      await insertMember(client, circles[1].circle.id, { phone, invitedSql: at('10:00:00.5') }),
      await insertMember(client, circles[2].circle.id, { phone, invitedSql: at('10:00:00') }),
      await insertMember(client, circles[3].circle.id, { phone, invitedSql: at('10:00:00.05') }),
      await insertMember(client, circles[4].circle.id, { phone, invitedSql: at('09:59:59.9') }),
    ];
    // What the SQL function returns for the same state (rolled back; it claims too).
    const sql = await sqlRolledBack<Body[]>(client, invitee.id, 'public.list_my_circle_invites()');
    const ids = (await invitesOf(invitee)).map((x) => x.member_id as string);
    const tied = [rows[0].id, rows[1].id].sort();
    // The SQL sorts the JSON TEXT of invited_at (ICU en-US here): a whole-second value sorts above
    // the fractional values of the same second. The API uses the same expression, so the same order.
    expect(ids).toEqual([rows[2].id, ...tied, rows[3].id, rows[4].id]);
    const sqlIds = (sql.body ?? []).map((x) => x.member_id as string);
    expect(sqlIds.filter((id) => !tied.includes(id))).toEqual([rows[2].id, rows[3].id, rows[4].id]);
    expect(new Set(sqlIds.slice(1, 3))).toEqual(new Set(tied));
  });

  it('answers what the SQL function answers and claims the same rows (interchangeable)', async () => {
    const phone = phoneNumber();
    const invitee = await createUser(client, { fullName: 'Same Answer', phone });
    const a = await ownerWithCircle('Same A');
    const b = await ownerWithCircle('Same B');
    const c = await ownerWithCircle('Same C');
    await insertMember(client, a.circle.id, { phone, invitedSql: "now() - interval '5 minutes'" });
    await insertExpiredMember(client, b.circle.id, { phone });
    await insertMember(client, c.circle.id, { phone, status: 'declined', canceled: true });
    await insertMember(client, c.circle.id, {
      userId: invitee.id,
      invitedSql: "now() - interval '1 day'",
    });
    const circles = [a.circle.id, b.circle.id, c.circle.id];
    const first = await compareList(invitee, circles);
    expect((first.sqlBody as Body[]).length).toBe(4);
    // After the API claimed, the SQL (and the API again) see the same.
    await compareList(invitee, circles);
    // A claim by the SQL function, then the API: same rows, same answer.
    const d = await ownerWithCircle('Same D');
    const fresh = await insertMember(client, d.circle.id, { phone });
    await sqlAs(client, invitee.id, 'public.list_my_circle_invites()');
    expect((await memberRow(client, fresh.id)).user_id).toBe(invitee.id);
    await compareList(invitee, [...circles, d.circle.id]);
    // A caller with nothing: [] from both.
    const nobody = await createUser(client);
    const empty = await compareList(nobody, []);
    expect(empty.reply.body).toBe('[]');
  });

  it('SCRUM-33 (D46): owner_avatar_url is the inviting owner’s public avatar URL on every listed row; null without a photo', async () => {
    const phone = phoneNumber();
    const invitee = await createUser(client, { phone });
    const withPath = await ownerWithCircle('Photo Path');
    const withUrl = await ownerWithCircle('Photo Url');
    const blank = await ownerWithCircle('Blank Photo');
    const none = await ownerWithCircle('No Photo');
    const setAvatar = (id: string, path: string | null) =>
      client.query('update public.profiles set avatar_path = $2 where id = $1', [id, path]);
    await setAvatar(withPath.owner.id, `${withPath.owner.id}/avatar.png`);
    await setAvatar(withUrl.owner.id, 'HTTPS://cdn.example.test/a.png');
    await setAvatar(blank.owner.id, '   ');
    await setAvatar(none.owner.id, null);
    const pending = await insertMember(client, withPath.circle.id, { phone });
    const expired = await insertExpiredMember(client, withUrl.circle.id, { phone });
    const canceled = await insertMember(client, blank.circle.id, {
      phone,
      status: 'declined',
      canceled: true,
    });
    const plain = await insertMember(client, none.circle.id, { phone });

    const byId: Record<string, Body> = Object.fromEntries(
      (await invitesOf(invitee)).map((x) => [x.member_id as string, x]),
    );
    expect(byId[pending.id].owner_avatar_url).toBe(
      `https://${PROJECT_HOST}/storage/v1/object/public/avatars/${withPath.owner.id}/avatar.png`,
    );
    // An http(s) URL is kept as is; the photo is shown on expired and canceled rows too.
    expect(byId[expired.id]).toMatchObject({
      status: 'expired',
      owner_avatar_url: 'HTTPS://cdn.example.test/a.png',
    });
    expect(byId[canceled.id]).toMatchObject({ status: 'canceled', owner_avatar_url: null });
    expect(byId[plain.id].owner_avatar_url).toBeNull();
    // The rest of each element is still exactly the SQL function's answer.
    await compareList(invitee, [
      withPath.circle.id,
      withUrl.circle.id,
      blank.circle.id,
      none.circle.id,
    ]);
  });

  it('never makes a row active and never touches activated_at', async () => {
    const phone = phoneNumber();
    const invitee = await createUser(client, { phone });
    const { circle } = await ownerWithCircle();
    const row = await insertMember(client, circle.id, { phone });
    await invitesOf(invitee);
    expect(await memberRow(client, row.id)).toMatchObject({
      status: 'pending',
      activated_at: null,
      invite_consumed_at: null,
    });
  });

  // --- GET /v1/me/joined-circles ----------------------------------------------------------------

  it('without a token: 401 list_my_joined_circles:not_authenticated', async () => {
    const reply = await listJoinedCircles(app, null);
    expect(reply.statusCode).toBe(401);
    expect(errorOf(reply).code).toBe('list_my_joined_circles:not_authenticated');
  });

  it('lists the own circle (role owner) and joined circles, counts exclude the owner, pending and declined', async () => {
    const user = await createUser(client, { fullName: 'Joiner Owner', phone: phoneNumber() });
    const own = await createCircle(client, user);
    const friend = await createUser(client);
    await addActiveMember(client, own, friend);
    await insertMember(client, own.id); // pending: not counted
    const x = await ownerWithCircle('Xena Owner');
    const membership = await addActiveMember(client, x.circle, user);
    await addActiveMember(client, x.circle, await createUser(client));
    await addActiveMember(client, x.circle, await createUser(client));
    await insertMember(client, x.circle.id, { status: 'declined', canceled: true });
    const y = await ownerWithCircle('Yuri Owner');
    // Only pending / declined there: not listed.
    await insertMember(client, y.circle.id, { userId: user.id });
    // The own circle was joined a day earlier: listed last.
    await setUpdatedAt([own.ownerMemberId], "now() - interval '1 day'");

    const reply = await listJoinedCircles(app, user.id);
    expect(reply.statusCode).toBe(200);
    const listed = reply.json<Body[]>();
    expect(listed.map((e) => e.circle_id)).toEqual([x.circle.id, own.id]);
    for (const e of listed) expect(Object.keys(e).sort()).toEqual(JOINED_KEYS);
    expect(listed[0]).toMatchObject({
      role: 'member',
      member_id: membership.id,
      status: 'active',
      name: 'My Safety Circle',
      owner_name: 'Xena Owner',
      active_member_count: 3,
    });
    expect(listed[1]).toMatchObject({
      role: 'owner',
      member_id: own.ownerMemberId,
      owner_name: 'Joiner Owner',
      active_member_count: 1,
    });
    // joined_at is the member row's updated_at.
    const updated = (
      await client.query<{ t: string }>(
        `select to_json(updated_at)#>>'{}' as t from public.safety_circle_members where id = $1`,
        [own.ownerMemberId],
      )
    ).rows[0].t;
    expect(new Date(listed[1].joined_at as string).getTime()).toBe(new Date(updated).getTime());

    await compareJoined(user, [own.id, x.circle.id, y.circle.id]);
  });

  it('a user in no circle gets [] (as the SQL), and the answer equals the SQL for a member', async () => {
    const nobody = await createUser(client);
    expect((await compareJoined(nobody, [])).reply.body).toBe('[]');
    const { owner, circle } = await ownerWithCircle('Plain Owner');
    const member = await createUser(client);
    await addActiveMember(client, circle, member);
    await compareJoined(member, [circle.id]);
    await compareJoined(owner, [circle.id]);
  });

  it('orders by joined_at desc, then member_id for equal joined_at', async () => {
    const user = await createUser(client);
    const circles = await Promise.all([1, 2, 3].map(() => ownerWithCircle()));
    const rows = [];
    for (const { circle } of circles) rows.push(await addActiveMember(client, circle, user));
    await setUpdatedAt([rows[0].id, rows[1].id], "timestamptz '2026-11-19 09:00:00.25+00'");
    await setUpdatedAt([rows[2].id], "timestamptz '2026-11-18 09:00:00.25+00'");
    const ids = (await listJoinedCircles(app, user.id)).json<Body[]>().map((e) => e.member_id);
    expect(ids).toEqual([...[rows[0].id, rows[1].id].sort(), rows[2].id]);
    const sql = await sqlRolledBack<Body[]>(client, user.id, 'public.list_my_joined_circles()');
    expect(new Set((sql.body ?? []).map((e) => e.member_id))).toEqual(new Set(ids));
    expect((sql.body ?? [])[2].member_id).toBe(rows[2].id);
  });
});
