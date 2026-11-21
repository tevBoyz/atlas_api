import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AppModule } from '../../src/app.module';
import { buildOpenApiDocument } from '../../src/openapi/openapi.document';
import { collectControllers, discoverRoutes } from '../../src/openapi/route-discovery';
import { scrubString } from '../../src/observability/scrubber';
import { safePath } from '../../src/observability/tracing';
import { RedisService } from '../../src/redis';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  declineInvite,
  errorOf,
  lookupInvite,
  previewInvite,
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
import {
  compareWithSql,
  insertExpiredMember,
  insertMember,
  insertOverCapacity,
  memberRow,
} from '../support/invite-rows';

/**
 * API-100-29: the public invite status (`GET /v1/invites/{token}/status`, `lookup_circle_invite`)
 * and the preview with its claim (`POST /v1/invites/{token}/preview`, `preview_circle_invite`):
 * every acceptance criterion, the SQL answer for the same state and caller (JSON text, rows and
 * codes), the per-IP limit, and that the token in the path never reaches the logs.
 */
type Body = Record<string, unknown>;

const PROJECT_HOST = 'example-project.supabase.co';

describe('invite lookup and preview (API-100-29)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp(
      {},
      withTestConfig({
        SUPABASE_URL: `https://${PROJECT_HOST}/`,
        LOG_LEVEL: 'trace',
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_PUBLIC_MAX: '1000000',
      }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  interface Owned {
    owner: UserFixture;
    circle: CircleFixture;
  }
  const ownerWithCircle = async (fullName = 'Ada Owner'): Promise<Owned> => {
    const owner = await createUser(client, { fullName, phone: true });
    return { owner, circle: await createCircle(client, owner) };
  };

  const sqlLookup = (token: string) =>
    sqlAs<Body>(client, randomUUID(), 'public.lookup_circle_invite($1)', [token]);

  // --- GET /v1/invites/{token}/status -----------------------------------------------------------

  describe('lookup (AC1)', () => {
    it('is public: no Authorization needed, and a token is not required either', async () => {
      const { circle } = await ownerWithCircle();
      const row = await insertMember(client, circle.id);
      const anonymous = await lookupInvite(app, row.token);
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.json<Body>().status).toBe('pending');
      const signedIn = await lookupInvite(app, row.token, { userId: randomUUID() });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.body).toBe(anonymous.body);
      expect(anonymous.headers['cache-control']).toBe('no-store');
    });

    it('every lookup status, with the precedence of spec §5.3, exactly as the SQL', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ben = await createUser(client);
      const cases: Record<string, Promise<{ id: string; token: string }>> = {
        pending: insertMember(client, circle.id),
        expired: insertExpiredMember(client, circle.id),
        consumed: insertMember(client, circle.id, {
          status: 'active',
          userId: ben.id,
          consumed: true,
        }),
        canceled: insertMember(client, circle.id, { status: 'declined', canceled: true }),
        // 1 canceled wins over 2 consumed and 3 expired.
        canceledAndConsumed: insertExpiredMember(client, circle.id, {
          canceled: true,
          consumed: true,
        }),
        // A declined row without invite_canceled_at is still canceled.
        declinedOnly: insertMember(client, circle.id, { status: 'declined' }),
        // 2 consumed wins over 3 expired.
        consumedExpired: insertExpiredMember(client, circle.id, { consumed: true }),
        // No invite_expires_at: invited_at + 7 days.
        noExpiryOld: insertMember(client, circle.id, {
          invitedSql: "now() - interval '8 days'",
          expiresSql: 'null',
          status: 'declined',
        }),
        expiresExactlyNow: insertMember(client, circle.id, { expiresSql: 'now()' }),
      };
      const expected: Record<string, string> = {
        pending: 'pending',
        expired: 'expired',
        consumed: 'consumed',
        canceled: 'canceled',
        canceledAndConsumed: 'canceled',
        declinedOnly: 'canceled',
        consumedExpired: 'consumed',
        noExpiryOld: 'canceled',
        expiresExactlyNow: 'expired',
      };
      for (const [name, rowPromise] of Object.entries(cases)) {
        const row = await rowPromise;
        const reply = await lookupInvite(app, row.token);
        expect({ name, status: reply.statusCode }).toEqual({ name, status: 200 });
        expect({ name, body: reply.json<Body>().status }).toEqual({ name, body: expected[name] });
        expect(reply.body).toBe(JSON.stringify(await sqlLookup(row.token)));
        // Never a name, phone or id.
        expect(Object.keys(reply.json<Body>())).toEqual(['status', 'invite_expires_at']);
        for (const secret of [row.id, circle.id, owner.id, ben.id, 'Row Name', 'Ada']) {
          expect(reply.body).not.toContain(secret);
        }
      }
    });

    it('blank, unknown and padded tokens; text Postgres cannot hold is 422', async () => {
      const { circle } = await ownerWithCircle();
      const row = await insertMember(client, circle.id);
      const notFound = JSON.stringify(await sqlLookup('   '));
      expect(notFound).toBe('{"status":"not_found","invite_expires_at":null}');
      for (const path of ['%20', '%20%20%20', encodeURIComponent(fakeInviteToken()), 'x']) {
        const reply = await lookupInvite(app, path, { raw: true });
        expect({ path, status: reply.statusCode, body: reply.body }).toEqual({
          path,
          status: 200,
          body: notFound,
        });
      }
      // Trimmed (spaces only), as the SQL's trim().
      const padded = await lookupInvite(app, `%20${row.token}%20%20`, { raw: true });
      expect(padded.json<Body>().status).toBe('pending');
      expect(padded.body).toBe(JSON.stringify(await sqlLookup(`  ${row.token} `)));
      // A tab is not trimmed by Postgres trim(): not found.
      expect((await lookupInvite(app, `%09${row.token}`, { raw: true })).json<Body>().status).toBe(
        'not_found',
      );
      const nul = await lookupInvite(app, `${row.token}%00`, { raw: true });
      expect(nul.statusCode).toBe(422);
      expect(errorOf(nul).code).toBe('validation:invalid_request');
      expect(errorOf(nul).details).toEqual({ field: 'token' });
    });

    it('reads only: no row is locked or written', async () => {
      const { circle } = await ownerWithCircle();
      const row = await insertMember(client, circle.id);
      const before = await memberRow(client, row.id);
      await client.query('begin');
      try {
        await client.query('select 1 from public.safety_circle_members where id = $1 for update', [
          row.id,
        ]);
        // Answers while another transaction holds the row lock.
        expect((await lookupInvite(app, row.token)).statusCode).toBe(200);
      } finally {
        await client.query('rollback');
      }
      expect(await memberRow(client, row.id)).toEqual(before);
    });
  });

  describe('lookup rate limit (AC1: per IP, the public policy of API-100-11)', () => {
    let limited: NestFastifyApplication;
    beforeAll(async () => {
      ({ app: limited } = await createTestApp(
        {},
        withTestConfig({
          RATE_LIMIT_PUBLIC_MAX: '3',
          RATE_LIMIT_PUBLIC_WINDOW_SECONDS: '300',
          TRUST_PROXY: 'true',
        }),
      ));
      const redis = limited.get(RedisService);
      for (let i = 0; i < 100 && redis.client.status !== 'ready'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(redis.client.status).toBe('ready');
    });
    afterAll(async () => {
      await limited?.close();
    });

    it('the 4th lookup from one IP in the window is 429 rate_limit:exceeded; another IP is not limited', async () => {
      const token = fakeInviteToken();
      const from = (ip: string, userId?: string) =>
        lookupInvite(limited, token, { headers: { 'x-forwarded-for': ip }, userId });
      for (let i = 0; i < 3; i += 1) expect((await from('203.0.113.7')).statusCode).toBe(200);
      // A signed-in caller is still counted per IP on this public route.
      const over = await from('203.0.113.7', randomUUID());
      expect(over.statusCode).toBe(429);
      expect(errorOf(over).code).toBe('rate_limit:exceeded');
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      expect((await from('203.0.113.8')).statusCode).toBe(200);
    });
  });

  describe('the token in the path stays out of logs and traces', () => {
    it('no log line of status, preview, accept or decline (success or error) carries the token', async () => {
      const { owner, circle } = await ownerWithCircle();
      const joiner = await createUser(client);
      const row = await insertMember(client, circle.id);
      const unknown = fakeInviteToken();
      const before = logs.text.length;
      await lookupInvite(app, row.token);
      await lookupInvite(app, unknown);
      await lookupInvite(app, `${unknown}%00`, { raw: true });
      await previewInvite(app, owner.id, row.token);
      await previewInvite(app, null, row.token);
      await acceptInvite(app, owner.id, row.token);
      await acceptInvite(app, joiner.id, row.token);
      await acceptInvite(app, joiner.id, row.token);
      await declineInvite(app, joiner.id, row.token);
      await declineInvite(app, joiner.id, unknown);
      const written = logs.text.slice(before);
      expect(written).toContain('/v1/invites/:token/status');
      expect(written).toContain('/v1/invites/:token/accept');
      expect(written).not.toContain(row.token);
      expect(written).not.toContain(unknown);
      expect(written).not.toContain(row.token.slice(0, 16));
    });

    it('traces and free text scrub invites/<token>', () => {
      const token = fakeInviteToken();
      expect(safePath(`/v1/invites/${token}/status?x=1`)).toBe('/v1/invites/[REDACTED]/status');
      expect(scrubString(`failed on /v1/invites/${token}/accept`)).not.toContain(token);
    });
  });

  describe('OpenAPI', () => {
    it('documents {token} as a path parameter; status is public, the others need a bearer token', () => {
      const document = buildOpenApiDocument(discoverRoutes(collectControllers(AppModule))) as {
        paths: Record<string, Record<string, Body>>;
      };
      const status = document.paths['/v1/invites/{token}/status'].get;
      expect(status.operationId).toBe('lookupCircleInvite');
      expect(status.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'token', in: 'path', required: true }),
        ]),
      );
      expect(status.security).toEqual([]);
      for (const action of ['preview', 'accept', 'decline']) {
        const op = document.paths[`/v1/invites/{token}/${action}`].post;
        expect(op.parameters).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'token', in: 'path' })]),
        );
        expect(op.security).not.toEqual([]);
      }
    });
  });

  // --- POST /v1/invites/{token}/preview --------------------------------------------------------

  describe('preview (AC2-AC5), each case against preview_circle_invite', () => {
    const compare = (
      caller: UserFixture,
      token: string,
      circleIds: string[],
      options: { raw?: boolean } = {},
    ) =>
      compareWithSql(client, {
        callerId: caller.id,
        sqlCall: 'public.preview_circle_invite($1)',
        params: [options.raw ? decodeURIComponent(token) : token],
        circleIds,
        api: () => previewInvite(app, caller.id, token, options),
        host: PROJECT_HOST,
      });
    const previewOf = async (caller: UserFixture, token: string, circleIds: string[]) =>
      (await compare(caller, token, circleIds)).reply.json<Body>();

    it('not_found: unknown and blank tokens (all other keys null/false)', async () => {
      const { owner, circle } = await ownerWithCircle();
      for (const token of [fakeInviteToken(), '%20%20']) {
        const { reply } = await compare(owner, token, [circle.id], { raw: token.startsWith('%') });
        expect(reply.json<Body>()).toEqual({
          status: 'not_found',
          invite_expires_at: null,
          member_id: null,
          circle_id: null,
          owner_name: null,
          invited_at: null,
          claimed: false,
          recipient_ok: false,
          owner_avatar_url: null,
        });
      }
    });

    it('own_circle: the owner sees their circle; never claims (claimed is SQL null when unclaimed)', async () => {
      const { owner, circle } = await ownerWithCircle('Owner One');
      await client.query(`update public.profiles set avatar_path = $2 where id = $1`, [
        owner.id,
        `${owner.id}/avatar.png`,
      ]);
      const link = await insertMember(client, circle.id);
      const body = await previewOf(owner, link.token, [circle.id]);
      expect(body).toMatchObject({
        status: 'own_circle',
        owner_name: 'Owner One',
        circle_id: circle.id,
        member_id: link.id,
        claimed: null,
        recipient_ok: true,
        owner_avatar_url: `https://${PROJECT_HOST}/storage/v1/object/public/avatars/${owner.id}/avatar.png`,
      });
      expect((await memberRow(client, link.id)).user_id).toBeNull();
      // A phone invite to another number: not the recipient, still own_circle, no claim.
      const phoneRow = await insertMember(client, circle.id, { phone: '+12015550188' });
      expect(await previewOf(owner, phoneRow.token, [circle.id])).toMatchObject({
        status: 'own_circle',
        recipient_ok: false,
        claimed: null,
      });
    });

    it('already_member: the caller’s own active row, and another active row in the circle', async () => {
      const { circle } = await ownerWithCircle('Owner One');
      const ben = await createUser(client, { fullName: 'Ben' });
      const active = await addActiveMember(client, circle, ben);
      expect(await previewOf(ben, active.inviteToken, [circle.id])).toMatchObject({
        status: 'already_member',
        member_id: active.id,
        owner_name: 'Owner One',
        claimed: true,
      });
      const other = await insertMember(client, circle.id, { name: 'Someone Else' });
      expect(await previewOf(ben, other.token, [circle.id])).toMatchObject({
        status: 'already_member',
        member_id: other.id,
        owner_name: 'Owner One',
        claimed: false,
        recipient_ok: true,
      });
      expect((await memberRow(client, other.id)).user_id).toBeNull();
    });

    it('consumed: someone else’s active row shows nothing', async () => {
      const { circle } = await ownerWithCircle();
      const ben = await createUser(client);
      const cara = await createUser(client);
      const active = await addActiveMember(client, circle, ben);
      expect(await previewOf(cara, active.inviteToken, [circle.id])).toEqual({
        status: 'consumed',
        invite_expires_at: expect.any(String) as unknown,
        member_id: null,
        circle_id: null,
        owner_name: null,
        invited_at: null,
        claimed: false,
        recipient_ok: false,
        owner_avatar_url: null,
      });
    });

    it('canceled: row ids only for the recipient; the owner is never shown', async () => {
      const { circle } = await ownerWithCircle();
      const dan = await createUser(client, { phone: true });
      const eve = await createUser(client, { phone: true });
      const canceledPhone = await insertMember(client, circle.id, {
        phone: dan.phone,
        status: 'declined',
        canceled: true,
        userId: dan.id,
      });
      expect(await previewOf(dan, canceledPhone.token, [circle.id])).toMatchObject({
        status: 'canceled',
        member_id: canceledPhone.id,
        owner_name: null,
        owner_avatar_url: null,
        claimed: true,
        recipient_ok: true,
      });
      expect(await previewOf(eve, canceledPhone.token, [circle.id])).toMatchObject({
        status: 'canceled',
        member_id: null,
        circle_id: null,
        claimed: false,
        recipient_ok: false,
      });
      const canceledLink = await insertMember(client, circle.id, {
        status: 'declined',
        canceled: true,
      });
      // Unclaimed link: `recipient_ok and user_id = uid` is SQL null.
      expect(await previewOf(eve, canceledLink.token, [circle.id])).toMatchObject({
        status: 'canceled',
        member_id: canceledLink.id,
        claimed: null,
        recipient_ok: true,
      });
    });

    it('expired: owner and row only for the recipient; never claims', async () => {
      const { circle } = await ownerWithCircle('Owner One');
      const dan = await createUser(client, { phone: true });
      const eve = await createUser(client, { phone: true });
      const expiredPhone = await insertExpiredMember(client, circle.id, { phone: dan.phone });
      expect(await previewOf(dan, expiredPhone.token, [circle.id])).toMatchObject({
        status: 'expired',
        member_id: expiredPhone.id,
        owner_name: 'Owner One',
        claimed: null,
        recipient_ok: true,
      });
      expect(await previewOf(eve, expiredPhone.token, [circle.id])).toMatchObject({
        status: 'expired',
        member_id: null,
        owner_name: null,
        recipient_ok: false,
        claimed: false,
      });
      expect((await memberRow(client, expiredPhone.id)).user_id).toBeNull();
    });

    it('pending link invite: claims for the caller (status stays pending); safe to repeat', async () => {
      const { circle } = await ownerWithCircle('Owner One');
      const joiner = await createUser(client);
      const link = await insertMember(client, circle.id, { name: 'Invited member' });
      const first = await previewOf(joiner, link.token, [circle.id]);
      expect(first).toMatchObject({
        status: 'pending',
        member_id: link.id,
        circle_id: circle.id,
        owner_name: 'Owner One',
        claimed: true,
        recipient_ok: true,
        owner_avatar_url: null,
      });
      // The SQL comparison rolled its own claim back; the API's stays.
      const stored = await memberRow(client, link.id);
      expect(stored).toMatchObject({ user_id: joiner.id, status: 'pending', activated_at: null });
      const again = await previewOf(joiner, link.token, [circle.id]);
      expect(again).toEqual(first);
      expect((await memberRow(client, link.id)).updated_at).toEqual(stored.updated_at);
      // Claimed: another user is no longer the recipient and sees nothing.
      const other = await createUser(client);
      expect(await previewOf(other, link.token, [circle.id])).toMatchObject({
        status: 'pending',
        member_id: null,
        owner_name: null,
        claimed: false,
        recipient_ok: false,
      });
    });

    it('pending phone invite: the caller’s normalized Auth phone must equal the row phone', async () => {
      const { circle } = await ownerWithCircle();
      // Auth stores phones without "+" (createUser); the row has strict E.164.
      const dan = await createUser(client, { phone: true });
      const eve = await createUser(client, { phone: true });
      const noPhone = await createUser(client);
      const row = await insertMember(client, circle.id, { phone: dan.phone });
      for (const caller of [eve, noPhone]) {
        expect(await previewOf(caller, row.token, [circle.id])).toMatchObject({
          status: 'pending',
          member_id: null,
          recipient_ok: false,
          claimed: false,
        });
      }
      expect(await previewOf(dan, row.token, [circle.id])).toMatchObject({
        status: 'pending',
        member_id: row.id,
        recipient_ok: true,
        claimed: true,
      });
      expect((await memberRow(client, row.id)).user_id).toBe(dan.id);
      // Auth phone with spaces around it still matches (normalized).
      const fay = await createUser(client);
      const fayPhone = '+12015550177';
      await client.query(`update auth.users set phone = $2 where id = $1`, [
        fay.id,
        `  ${fayPhone.slice(1)} `,
      ]);
      const fayRow = await insertMember(client, circle.id, { phone: fayPhone });
      expect(await previewOf(fay, fayRow.token, [circle.id])).toMatchObject({
        status: 'pending',
        recipient_ok: true,
        claimed: true,
      });
    });

    it('circle_full: other active + other valid pending + 1 > 5; claims only without another row', async () => {
      const { circle } = await ownerWithCircle('Owner Three');
      const users = await Promise.all([1, 2, 3, 4, 5].map(() => createUser(client)));
      const blocked = await createUser(client);
      const rows = await insertOverCapacity(client, circle.id, [
        ...users.map((u) => ({ status: 'active' as const, userId: u.id, consumed: true })),
        { name: 'Blocked' },
        { name: 'Second' },
      ]);
      const [blockedRow, secondRow] = rows.slice(5);
      expect(await previewOf(blocked, blockedRow.token, [circle.id])).toMatchObject({
        status: 'circle_full',
        owner_name: 'Owner Three',
        circle_id: circle.id,
        claimed: true,
        recipient_ok: true,
      });
      expect(await memberRow(client, blockedRow.id)).toMatchObject({
        user_id: blocked.id,
        status: 'pending',
      });
      // The same caller on a second invite of that circle: it holds a row there, no claim.
      expect(await previewOf(blocked, secondRow.token, [circle.id])).toMatchObject({
        status: 'circle_full',
        claimed: false,
      });
      expect((await memberRow(client, secondRow.id)).user_id).toBeNull();
      // Repeat by the claimant: still claimed, no write.
      expect(await previewOf(blocked, blockedRow.token, [circle.id])).toMatchObject({
        claimed: true,
      });
    });

    it('expired rows hold no slot: 5 used with an expired row is not circle_full', async () => {
      const { circle } = await ownerWithCircle();
      const users = await Promise.all([1, 2, 3, 4].map(() => createUser(client)));
      for (const u of users) await addActiveMember(client, circle, u);
      await insertExpiredMember(client, circle.id);
      const link = await insertMember(client, circle.id);
      const joiner = await createUser(client);
      expect(await previewOf(joiner, link.token, [circle.id])).toMatchObject({
        status: 'pending',
        claimed: true,
      });
    });

    it('duplicate_membership: a claim that clashes with the caller’s other LIVE row is 409, nothing written', async () => {
      const { circle } = await ownerWithCircle();
      const dan = await createUser(client);
      // Dan already holds a still-valid pending row of this circle (two live invites): the new
      // link invite cannot be claimed, by the SQL nor by the API (D41 releases finished rows only).
      const live = await insertMember(client, circle.id, { userId: dan.id, name: 'Claimed' });
      const liveBefore = await memberRow(client, live.id);
      const link = await insertMember(client, circle.id);
      const { reply } = await compare(dan, link.token, [circle.id]);
      expect(reply.statusCode).toBe(409);
      expect(errorOf(reply).code).toBe('preview_circle_invite:duplicate_membership');
      expect((await memberRow(client, link.id)).user_id).toBeNull();
      expect(await memberRow(client, live.id)).toEqual(liveBefore);
    });

    it('D41 divergence: the caller’s DECLINED row no longer blocks the claim (SQL still 409, API 200)', async () => {
      const { circle } = await ownerWithCircle();
      const dan = await createUser(client);
      // Dan already holds a (declined) row of this circle.
      const declined = await insertMember(client, circle.id, {
        status: 'declined',
        canceled: true,
        userId: dan.id,
      });
      const link = await insertMember(client, circle.id);
      // The SQL function is unchanged and still refuses this case (parity assertion kept) ...
      const sqlSide = await sqlRolledBack(client, dan.id, 'public.preview_circle_invite($1)', [
        link.token,
      ]);
      expect(sqlSide.error).toBe('preview_circle_invite:duplicate_membership');
      expect((await memberRow(client, link.id)).user_id).toBeNull();
      // ... the API deliberately diverges (D41, approved by Dawit 2026-11-21): it releases the
      // finished row and claims the new one.
      const reply = await previewInvite(app, dan.id, link.token);
      expect(reply.statusCode).toBe(200);
      expect(reply.json<Body>()).toMatchObject({ status: 'pending', claimed: true });
      expect((await memberRow(client, link.id)).user_id).toBe(dan.id);
      expect(await memberRow(client, declined.id)).toMatchObject({
        status: 'declined',
        user_id: null,
      });
    });

    it('owner_avatar_url: the owner’s public avatar URL; null without a photo; http(s) kept', async () => {
      const { owner, circle } = await ownerWithCircle();
      const joiner = await createUser(client);
      const url = 'https://cdn.example.test/a.png';
      await client.query(`update public.profiles set avatar_path = $2 where id = $1`, [
        owner.id,
        url,
      ]);
      const link = await insertMember(client, circle.id);
      expect((await previewOf(joiner, link.token, [circle.id])).owner_avatar_url).toBe(url);
    });

    it('no token: 401 preview_circle_invite:not_authenticated', async () => {
      const reply = await previewInvite(app, null, fakeInviteToken());
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('preview_circle_invite:not_authenticated');
    });

    it('the preview never activates, never writes activated_at, and needs no profile', async () => {
      const { circle } = await ownerWithCircle();
      const noProfile = await createUser(client, { profile: false });
      const link = await insertMember(client, circle.id);
      expect(await previewOf(noProfile, link.token, [circle.id])).toMatchObject({
        status: 'pending',
        claimed: true,
      });
      expect(await memberRow(client, link.id)).toMatchObject({
        status: 'pending',
        activated_at: null,
        invite_consumed_at: null,
      });
      const profiles = await client.query('select 1 from public.profiles where id = $1', [
        noProfile.id,
      ]);
      expect(profiles.rowCount).toBe(0);
    });
  });
});
