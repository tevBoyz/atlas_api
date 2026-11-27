import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { errorOf, listMembers } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  fakeInviteToken,
  inviteMember,
  type UserFixture,
} from '../support/fixtures';

/**
 * `GET /v1/circles/{circle_id}/members` (`list_circle_members`, API-100-25):
 * the check order and codes, the exact key sets of the owner and member views, `expired`, the name
 * rules (live profile name, Postgres `trim`), `avatar_url` from `SUPABASE_URL` (D12), the ordering
 * with the database collation, and privacy of contact fields.
 */
type Member = Record<string, unknown>;

const PROJECT_HOST = 'example-project.supabase.co';
const MEMBER_KEYS = [
  'member_id',
  'role',
  'status',
  'display_name',
  'is_owner',
  'invited_at',
  'user_id',
  'handle',
  'avatar_url',
];
const OWNER_ONLY_KEYS = [
  'phone',
  'email',
  'relationship',
  'invite_expires_at',
  'invite_consumed_at',
  'invite_canceled_at',
];

describe('circle member list (API-100-25)', () => {
  /** The app configured like the hosted project (avatar URLs from SUPABASE_URL). */
  let app: NestFastifyApplication;
  /** The app without SUPABASE_URL (local default): avatar URLs are bare paths. */
  let bareApp: NestFastifyApplication;
  let client: Client;

  let owner: UserFixture;
  let ben: UserFixture;
  let cara: UserFixture;
  let claimant: UserFixture;
  let decliner: UserFixture;
  let outsider: UserFixture;
  let circle: CircleFixture;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ SUPABASE_URL: `https://${PROJECT_HOST}/` }),
    ));
    ({ app: bareApp } = await createTestApp({}, withTestConfig({ SUPABASE_URL: '' })));
    client = await openTestClient();

    owner = await createUser(client, { fullName: 'Ada Owner', phone: true });
    ben = await createUser(client, { fullName: '  Ben Profile  ', phone: true });
    cara = await createUser(client, { fullName: 'cara lower', phone: true });
    claimant = await createUser(client, { fullName: 'Claimant Profile', phone: true });
    decliner = await createUser(client, { fullName: 'Decliner Profile', phone: true });
    outsider = await createUser(client, { fullName: 'Outsider', phone: true });
    circle = await createCircle(client, owner);

    // Ben accepted under an old placeholder: the list shows his live profile name.
    const benRow = await addActiveMember(client, circle, ben);
    await client.query(
      `update public.safety_circle_members set display_name = 'Invited member' where id = $1`,
      [benRow.id],
    );
    await addActiveMember(client, circle, cara);
    // An active row without a profile keeps its stored name.
    const ghost = await createUser(client, { profile: false });
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                 invite_consumed_at)
       values ($1, 'member', 'active', 'Stored Ghost', $2, now())`,
      [circle.id, ghost.id],
    );
    // A pending invite claimed by a user keeps the invite name (not the profile name).
    await inviteMember(client, circle, { displayName: 'Dan Pending', claimedBy: claimant });
    await inviteMember(client, circle, { displayName: 'Eve Expired', expiresInDays: -1 });
    // A declined invite, as decline leaves it (user set, canceled, Stage 3 [B10b] declined_at).
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, phone,
         user_id, invite_token, invited_at, invite_expires_at, invite_canceled_at, declined_at)
       values ($1, 'member', 'declined', 'Fay Declined', $2, $3, $4, now(),
               now() + interval '7 days', now(), now())`,
      [circle.id, decliner.phone, decliner.id, fakeInviteToken()],
    );
    // Avatars: Ben with spaces around a path, Cara with an absolute URL in capitals.
    await client.query(`update public.profiles set avatar_path = $2 where id = $1`, [
      ben.id,
      '  ben-id/avatar.jpg  ',
    ]);
    await client.query(`update public.profiles set avatar_path = $2 where id = $1`, [
      cara.id,
      'HTTPS://cdn.example.test/cara.png',
    ]);
    await client.query(`update public.profiles set avatar_path = '   ' where id = $1`, [owner.id]);
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
    await bareApp?.close();
  });

  describe('errors, in order', () => {
    it('401 list_circle_members:not_authenticated without a token', async () => {
      const reply = await listMembers(app, null, circle.id);
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('list_circle_members:not_authenticated');
    });

    it('422 validation:invalid_request on circle_id for a value that is not uuid input', async () => {
      for (const bad of ['not-a-uuid', 'null', `${circle.id}0`]) {
        const reply = await listMembers(app, owner.id, bad);
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply)).toMatchObject({
          code: 'validation:invalid_request',
          details: { field: 'circle_id' },
        });
      }
    });

    it('404 list_circle_members:not_found for an unknown circle, also for an outsider (before access)', async () => {
      const unknown = randomUUID();
      for (const user of [owner, outsider]) {
        const reply = await listMembers(app, user.id, unknown);
        expect(reply.statusCode).toBe(404);
        expect(errorOf(reply).code).toBe('list_circle_members:not_found');
      }
    });

    it('accepts any Postgres uuid spelling (upper case, braces, no hyphens) like the RPC argument', async () => {
      const spellings = [circle.id.toUpperCase(), `{${circle.id}}`, circle.id.replace(/-/g, '')];
      for (const spelling of spellings) {
        expect((await listMembers(app, owner.id, spelling)).statusCode).toBe(200);
      }
    });

    it('403 list_circle_members:not_authorized for an outsider, a claimed pending invitee and a decliner', async () => {
      for (const user of [outsider, claimant, decliner]) {
        const reply = await listMembers(app, user.id, circle.id);
        expect(reply.statusCode).toBe(403);
        expect(errorOf(reply).code).toBe('list_circle_members:not_authorized');
      }
    });

    it('the owner may list even without an owner member row (circle.owner); a removed member may not', async () => {
      const soloOwner = await createUser(client, { fullName: 'Rowless Owner' });
      const soloCircle = randomUUID();
      await client.query(`insert into public.safety_circles (id, owner_id) values ($1, $2)`, [
        soloCircle,
        soloOwner.id,
      ]);
      const reply = await listMembers(app, soloOwner.id, soloCircle);
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe('[]');

      const leaver = await createUser(client, { fullName: 'Leaver' });
      const row = await addActiveMember(client, circle, leaver);
      expect((await listMembers(app, leaver.id, circle.id)).statusCode).toBe(200);
      await client.query('delete from public.safety_circle_members where id = $1', [row.id]);
      expect((await listMembers(app, leaver.id, circle.id)).statusCode).toBe(403);
    });
  });

  describe('owner view', () => {
    let rows: Member[];
    let body: string;

    beforeAll(async () => {
      const reply = await listMembers(app, owner.id, circle.id);
      expect(reply.statusCode).toBe(200);
      body = reply.body;
      rows = reply.json<Member[]>();
    });

    it('every row, 15 keys each (the 9 common + 6 owner-only), never invite_token', () => {
      expect(rows).toHaveLength(7);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([...MEMBER_KEYS, ...OWNER_ONLY_KEYS].sort());
      }
      expect(body).not.toContain('invite_token');
    });

    it('order: owner, then active < pending < expired < declined, then lower(name)', () => {
      expect(rows.map((r) => [r.display_name, r.status, r.is_owner])).toEqual([
        ['Ada Owner', 'active', true],
        ['Ben Profile', 'active', false],
        ['cara lower', 'active', false],
        ['Stored Ghost', 'active', false],
        ['Dan Pending', 'pending', false],
        ['Eve Expired', 'expired', false],
        ['Fay Declined', 'declined', false],
      ]);
    });

    it('names: live trimmed profile name for active rows with a user, else the stored name', () => {
      const byName: Record<string, Member> = Object.fromEntries(
        rows.map((r) => [r.display_name as string, r]),
      );
      // D79: no other user's id (the owner's own row only); rows are matched by handle = member_id.
      expect(byName['Ben Profile'].user_id).toBeNull();
      expect(byName['Stored Ghost']).toBeDefined();
      expect(byName['Dan Pending'].user_id).toBeNull();
      expect(byName['Fay Declined'].user_id).toBeNull();
      expect(byName['Ada Owner'].user_id).toBe(owner.id);
      for (const row of rows) expect(row.handle).toBe(row.member_id);
      for (const other of [ben, claimant, decliner]) expect(body).not.toContain(other.id);
      expect(body).not.toContain('Claimant Profile');
      expect(body).not.toContain('Decliner Profile');
    });

    it('avatar_url from SUPABASE_URL + trimmed avatar_path; absolute URLs kept; blank/none → null', () => {
      const byName: Record<string, Member> = Object.fromEntries(
        rows.map((r) => [r.display_name as string, r]),
      );
      expect(byName['Ben Profile'].avatar_url).toBe(
        `https://${PROJECT_HOST}/storage/v1/object/public/avatars/ben-id/avatar.jpg`,
      );
      expect(byName['cara lower'].avatar_url).toBe('HTTPS://cdn.example.test/cara.png');
      expect(byName['Ada Owner'].avatar_url).toBeNull();
      expect(byName['Stored Ghost'].avatar_url).toBeNull();
      expect(byName['Eve Expired'].avatar_url).toBeNull();
    });

    it('without SUPABASE_URL the avatar URL is the bare path', async () => {
      const reply = await listMembers(bareApp, owner.id, circle.id);
      const ben = reply.json<Member[]>().find((r) => r.display_name === 'Ben Profile');
      expect(ben?.avatar_url).toBe('/storage/v1/object/public/avatars/ben-id/avatar.jpg');
    });

    it('a profile name changes show at once on active rows (read live)', async () => {
      await client.query(`update public.profiles set full_name = 'Ben Renamed' where id = $1`, [
        ben.id,
      ]);
      try {
        const names = (await listMembers(app, owner.id, circle.id))
          .json<Member[]>()
          .map((r) => r.display_name);
        expect(names).toContain('Ben Renamed');
      } finally {
        await client.query(`update public.profiles set full_name = $2 where id = $1`, [
          ben.id,
          ben.fullName,
        ]);
      }
    });
  });

  describe('member view', () => {
    it('active rows only, 9 keys each; never phone, email, relationship or invite timestamps', async () => {
      const reply = await listMembers(app, ben.id, circle.id);
      expect(reply.statusCode).toBe(200);
      const rows = reply.json<Member[]>();
      expect(rows.map((r) => [r.display_name, r.status])).toEqual([
        ['Ada Owner', 'active'],
        ['Ben Profile', 'active'],
        ['cara lower', 'active'],
        ['Stored Ghost', 'active'],
      ]);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual([...MEMBER_KEYS].sort());
      for (const secret of [
        owner.phone,
        cara.phone,
        ben.email,
        cara.email,
        'friend',
        decliner.phone,
      ]) {
        expect(reply.body).not.toContain(secret as string);
      }
    });
  });

  describe('Postgres semantics kept: trim and collation', () => {
    it('a name of only a tab is not blank to Postgres trim (spaces only), so it is shown as stored in profiles', async () => {
      const tabby = await createUser(client, { fullName: 'Tab Placeholder' });
      const c = await createCircle(client, await createUser(client, { fullName: 'Tab Owner' }));
      await addActiveMember(client, c, tabby);
      await client.query(`update public.profiles set full_name = $2 where id = $1`, [
        tabby.id,
        '\t',
      ]);
      const reply = await listMembers(app, tabby.id, c.id);
      const names = reply.json<Member[]>().map((r) => r.display_name);
      expect(names).toContain('\t');
    });

    it('lower(name) ordering follows the database collation, ties by invited_at', async () => {
      const sorter = await createUser(client, { fullName: 'Zed Sorter' });
      const c = await createCircle(client, sorter);
      // The first four end up expired, the last five stay valid pending (at most 5 hold a slot).
      // 'Kim' / 'kim' are equal after lower(): the earlier invite ('kim', 6 minutes ago) comes first.
      const names = ['beta', 'Alpha', 'émile', 'Emile', '_under', 'Kim', 'kim', '10 ten', '9 nine'];
      for (const [i, name] of names.entries()) {
        await client.query(
          `insert into public.safety_circle_members (circle_id, role, status, display_name,
             invite_token, invited_at, invite_expires_at)
           values ($1, 'member', 'pending', $2, $3, now() - make_interval(mins => $4),
                   now() + interval '7 days')`,
          [c.id, name, fakeInviteToken(), i],
        );
        if (i === 3) {
          // Fill check: at most 5 valid pending; expire the earlier ones so more fit.
          await client.query(
            `update public.safety_circle_members set invite_expires_at = now() - interval '1 second'
              where circle_id = $1 and role = 'member'`,
            [c.id],
          );
        }
      }
      const reply = await listMembers(app, sorter.id, c.id);
      expect(reply.statusCode).toBe(200);
      const { rows } = await client.query<{ n: string }>(
        `select display_name as n from public.safety_circle_members
          where circle_id = $1 and role = 'member'
          order by case when invite_expires_at > now() then 1 else 2 end, lower(display_name),
                   invited_at`,
        [c.id],
      );
      expect(
        reply
          .json<Member[]>()
          .filter((r) => r.role === 'member')
          .map((r) => r.display_name),
      ).toEqual(rows.map((r) => r.n));
      const shown = rows.map((r) => r.n);
      expect(shown.indexOf('kim')).toBe(shown.indexOf('Kim') - 1);
    });
  });
});
