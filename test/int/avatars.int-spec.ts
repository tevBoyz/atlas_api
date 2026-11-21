import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AVATAR_STORAGE, type AvatarStorage } from '../../src/modules/profiles/avatar-storage';
import { MemoryAvatarStorage } from '../../src/modules/profiles/memory-avatar-storage';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { errorOf, listMembers, sqlAs } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser } from '../support/fixtures';
import {
  createAuthUser,
  createAvatarUploadUrl,
  getProfile,
  putPersonalInfo,
  setAvatar,
} from '../support/profile-api';
import { untilReady } from '../support/auth-api';

/**
 * API-100-37: profile photos through signed Storage URLs, with the in-memory Storage fake
 * (`AVATAR_STORAGE=memory`: no test ever calls Supabase Storage).
 *
 * - AC1 `POST /v1/me/avatar/upload-url`: the three types, 5,242,880 bytes, `{uid}/avatar-{uuid}.{ext}`,
 *   the signed upload works once (the fake enforces the bucket's rules), per-user rate limit, no-store.
 * - AC2 `PUT /v1/me/profile/avatar`: the caller's folder only, the object must exist, the profile
 *   points at it, the previous object is deleted after the commit (best effort, logged without the
 *   path); null removes the photo.
 * - AC3 `avatar_url` = `{SUPABASE_URL}/storage/v1/object/public/avatars/{avatar_path}` everywhere
 *   (profile, member list), equal to `_avatars_public_url` and the app's `getPublicUrl`.
 * - AC4 today's `{uid}/avatar.{ext}` paths stay valid.
 * - Storage not configured → 503 `profiles:avatar_storage_unavailable`; never a key in logs.
 */
type Body = Record<string, unknown>;

const SUPABASE_URL = 'https://example-project.supabase.co';
const publicUrl = (path: string) => `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}`;

describe('avatars through signed Storage URLs (API-100-37)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;
  let storage: MemoryAvatarStorage;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp(
      {},
      withTestConfig({
        SUPABASE_URL,
        AVATAR_STORAGE: 'memory',
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_AVATAR_UPLOAD_MAX: '1000000',
      }),
    ));
    storage = app.get<AvatarStorage>(AVATAR_STORAGE) as MemoryAvatarStorage;
    expect(storage).toBeInstanceOf(MemoryAvatarStorage);
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  /** Sends `size` bytes of `contentType` to an upload URL of the fake (same process). */
  const upload = (uploadUrl: string, contentType: string, size = 64) => {
    const url = new URL(uploadUrl);
    return app.inject({
      method: 'PUT',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': contentType },
      payload: Buffer.alloc(size, 1),
    });
  };

  /** upload-url + upload; returns the object path. */
  const uploadPhoto = async (userId: string, contentType = 'image/jpeg') => {
    const reply = await createAvatarUploadUrl(app, userId, {
      content_type: contentType,
      content_length: 64,
    });
    expect(reply.statusCode).toBe(200);
    const body = reply.json<Body>();
    expect((await upload(body.upload_url as string, contentType)).statusCode).toBe(200);
    return body.object_path as string;
  };

  const expectError = (
    reply: Awaited<ReturnType<typeof getProfile>>,
    status: number,
    code: string,
    field?: string,
  ) => {
    const { code: got, details } = errorOf(reply);
    expect({ status: reply.statusCode, code: got, details }).toEqual({
      status,
      code,
      details: field === undefined ? {} : { field },
    });
  };

  describe('AC1 POST /v1/me/avatar/upload-url', () => {
    it.each([
      ['image/jpeg', 'jpg'],
      ['image/png', 'png'],
      ['image/webp', 'webp'],
    ])(
      '%s → a new object {uid}/avatar-{uuid}.%s, PUT, 2-hour expiry, no-store',
      async (type, ext) => {
        const user = await createUser(client);
        const reply = await createAvatarUploadUrl(app, user.id, {
          content_type: type,
          content_length: 5_242_880,
        });
        expect(reply.statusCode).toBe(200);
        expect(reply.headers['cache-control']).toBe('no-store');
        const body = reply.json<Body>();
        expect(Object.keys(body)).toEqual([
          'upload_url',
          'method',
          'headers',
          'object_path',
          'expires_at',
        ]);
        expect(body.method).toBe('PUT');
        expect(body.headers).toEqual({ 'content-type': type });
        expect(body.object_path).toMatch(
          new RegExp(
            `^${user.id}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${ext}$`,
          ),
        );
        const ttl = Date.parse(body.expires_at as string) - Date.now();
        expect(ttl).toBeGreaterThan(7_100_000);
        expect(ttl).toBeLessThanOrEqual(7_200_000);
        // Every call is a new object.
        const again = (
          await createAvatarUploadUrl(app, user.id, { content_type: type, content_length: 1 })
        ).json<Body>();
        expect(again.object_path).not.toBe(body.object_path);
      },
    );

    it('works before the profile exists (onboarding uploads first)', async () => {
      const id = randomUUID();
      await createAuthUser(client, id);
      expect(
        (await createAvatarUploadUrl(app, id, { content_type: 'image/png', content_length: 9 }))
          .statusCode,
      ).toBe(200);
    });

    it('refuses other types, more than 5,242,880 bytes and malformed lengths', async () => {
      const user = await createUser(client);
      for (const type of ['image/gif', 'image/JPEG', '', null, undefined]) {
        expectError(
          await createAvatarUploadUrl(app, user.id, { content_type: type, content_length: 10 }),
          422,
          'profiles:invalid_content_type',
          'content_type',
        );
      }
      expectError(
        await createAvatarUploadUrl(app, user.id, {
          content_type: 'image/png',
          content_length: 5_242_881,
        }),
        422,
        'profiles:file_too_large',
        'content_length',
      );
      for (const length of [0, -1, 1.5, '10', null]) {
        expectError(
          await createAvatarUploadUrl(app, user.id, {
            content_type: 'image/png',
            content_length: length,
          }),
          422,
          'validation:invalid_request',
          'content_length',
        );
      }
      // Type is checked first.
      expectError(
        await createAvatarUploadUrl(app, user.id, {
          content_type: 'image/gif',
          content_length: 9e9,
        }),
        422,
        'profiles:invalid_content_type',
        'content_type',
      );
      expectError(
        await createAvatarUploadUrl(app, null, { content_type: 'image/png', content_length: 1 }),
        401,
        'profiles:not_authenticated',
      );
    });

    it('the signed URL takes the bytes once, with the bucket’s rules', async () => {
      const user = await createUser(client);
      const body = (
        await createAvatarUploadUrl(app, user.id, { content_type: 'image/png', content_length: 10 })
      ).json<Body>();
      const url = body.upload_url as string;
      expect((await upload(url, 'image/gif')).statusCode).toBe(415);
      expect((await upload(url, 'image/png', 5_242_881)).statusCode).toBe(413);
      expect((await upload(url, 'image/png')).statusCode).toBe(200);
      expect(storage.get(body.object_path as string)).toEqual({
        contentType: 'image/png',
        size: 64,
      });
      expect((await upload(url, 'image/png')).statusCode).toBe(400);
      expect(
        (await upload(url.replace(/token=[^&]+/, 'token=forged'), 'image/png')).statusCode,
      ).toBe(400);
    });

    it('is rate limited per user (avatar_upload policy)', async () => {
      const limited = await createTestApp(
        {},
        withTestConfig({ AVATAR_STORAGE: 'memory', RATE_LIMIT_AVATAR_UPLOAD_MAX: '2' }),
      );
      // Redis must be connected first: the limiter lets requests through while it is not.
      await untilReady(limited.app);
      try {
        const user = await createUser(client);
        const statuses: number[] = [];
        for (let i = 0; i < 3; i++) {
          statuses.push(
            (
              await createAvatarUploadUrl(limited.app, user.id, {
                content_type: 'image/png',
                content_length: 1,
              })
            ).statusCode,
          );
        }
        expect(statuses).toEqual([200, 200, 429]);
        const other = await createUser(client);
        expect(
          (
            await createAvatarUploadUrl(limited.app, other.id, {
              content_type: 'image/png',
              content_length: 1,
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        await limited.app.close();
      }
    });
  });

  describe('AC2 PUT /v1/me/profile/avatar', () => {
    it('sets the uploaded photo; replacing it deletes the previous object after the commit', async () => {
      const user = await createUser(client);
      const first = await uploadPhoto(user.id);
      const reply = await setAvatar(app, user.id, { object_path: first });
      expect(reply.statusCode).toBe(200);
      expect(reply.json<Body>()).toMatchObject({
        avatar_path: first,
        avatar_url: publicUrl(first),
      });
      expect(reply.body).toBe((await getProfile(app, user.id)).body);

      const second = await uploadPhoto(user.id, 'image/webp');
      const before = logs.raw.length;
      expect((await setAvatar(app, user.id, { object_path: second })).statusCode).toBe(200);
      expect(await storage.exists(first)).toBe(false);
      expect(await storage.exists(second)).toBe(true);
      const lines = logs.raw.slice(before).join('');
      expect(lines).toContain('avatar.previous_deleted');
      expect(lines).not.toContain(user.id);

      // null removes the photo and deletes the object.
      const cleared = await setAvatar(app, user.id, { object_path: null });
      expect(cleared.json<Body>()).toMatchObject({ avatar_path: null, avatar_url: null });
      expect(await storage.exists(second)).toBe(false);
    });

    it('refuses another folder, an object that was never uploaded, a missing profile and bad bodies', async () => {
      const user = await createUser(client);
      const other = await createUser(client);
      const theirs = await uploadPhoto(other.id);
      expectError(
        await setAvatar(app, user.id, { object_path: theirs }),
        422,
        'profiles:invalid_avatar_path',
        'object_path',
      );
      expectError(
        await setAvatar(app, user.id, { object_path: `${user.id}/avatar-never-uploaded.jpg` }),
        404,
        'profiles:avatar_not_found',
        'object_path',
      );
      expectError(
        await setAvatar(app, user.id, {}),
        422,
        'validation:invalid_request',
        'object_path',
      );
      expectError(
        await setAvatar(app, user.id, { object_path: 7 }),
        422,
        'validation:invalid_request',
        'object_path',
      );
      const id = randomUUID();
      await createAuthUser(client, id);
      expectError(
        await setAvatar(app, id, { object_path: null }),
        404,
        'profiles:profile_not_found',
      );
      // Nothing changed for the other user.
      expect(await storage.exists(theirs)).toBe(true);
      expect((await getProfile(app, user.id)).json<Body>().avatar_path).toBeNull();
    });

    it('an object of another user’s folder is never deleted (a stored foreign path is left alone)', async () => {
      const user = await createUser(client);
      const other = await createUser(client);
      const theirs = await uploadPhoto(other.id);
      await client.query('update public.profiles set avatar_path = $2 where id = $1', [
        user.id,
        theirs,
      ]);
      const mine = await uploadPhoto(user.id);
      expect((await setAvatar(app, user.id, { object_path: mine })).statusCode).toBe(200);
      expect(await storage.exists(theirs)).toBe(true);
    });
  });

  describe('AC3 / AC4 URL format and today’s paths', () => {
    it('avatar_url is the public URL everywhere, equal to _avatars_public_url; {uid}/avatar.jpg stays valid', async () => {
      const owner = await createUser(client, { fullName: 'Photo Owner' });
      const circle = await createCircle(client, owner);
      const member = await createUser(client, { fullName: 'Photo Member' });
      await addActiveMember(client, circle, member);
      // A photo the app uploaded directly before the switch (AC4).
      const legacy = `${member.id}/avatar.jpg`;
      storage.put(legacy);
      await client.query('update public.profiles set avatar_path = $2 where id = $1', [
        member.id,
        legacy,
      ]);

      const profile = (await getProfile(app, member.id)).json<Body>();
      expect(profile.avatar_url).toBe(publicUrl(legacy));
      const sqlUrl = await sqlAs<string>(
        client,
        member.id,
        'public._avatars_public_url($1)',
        [legacy],
        {
          host: 'example-project.supabase.co',
        },
      );
      expect(profile.avatar_url).toBe(sqlUrl);
      const listed = (await listMembers(app, owner.id, circle.id))
        .json<Body[]>()
        .find((row) => row.user_id === member.id);
      expect(listed?.avatar_url).toBe(publicUrl(legacy));

      // Setting the legacy path again is allowed (it exists); a new photo replaces it and deletes it.
      expect((await setAvatar(app, member.id, { object_path: legacy })).statusCode).toBe(200);
      const fresh = await uploadPhoto(member.id, 'image/png');
      expect(
        (await setAvatar(app, member.id, { object_path: fresh })).json<Body>().avatar_url,
      ).toBe(publicUrl(fresh));
      expect(await storage.exists(legacy)).toBe(false);
      // Personal Info may still carry a path of the caller's folder (as the app sends it today).
      expect(
        (
          await putPersonalInfo(app, member.id, {
            full_name: 'Photo Member',
            date_of_birth: '1990-01-15',
            avatar_path: legacy,
          })
        ).json<Body>().avatar_url,
      ).toBe(publicUrl(legacy));
    });
  });

  describe('Storage not configured (AVATAR_STORAGE=supabase without a key)', () => {
    it('upload-url and set-avatar answer 503 profiles:avatar_storage_unavailable; removal still works, the deletion failure is only logged', async () => {
      const bare = await createTestApp(
        {},
        withTestConfig({ SUPABASE_URL, AVATAR_STORAGE: 'supabase' }),
      );
      try {
        const user = await createUser(client);
        expectError(
          await createAvatarUploadUrl(bare.app, user.id, {
            content_type: 'image/png',
            content_length: 1,
          }),
          503,
          'profiles:avatar_storage_unavailable',
        );
        expectError(
          await setAvatar(bare.app, user.id, { object_path: `${user.id}/avatar.png` }),
          503,
          'profiles:avatar_storage_unavailable',
        );
        await client.query('update public.profiles set avatar_path = $2 where id = $1', [
          user.id,
          `${user.id}/avatar.png`,
        ]);
        const reply = await setAvatar(bare.app, user.id, { object_path: null });
        expect(reply.statusCode).toBe(200);
        expect(reply.json<Body>().avatar_path).toBeNull();
        expect(bare.logs.text).toContain('avatar.previous_delete_failed');
        expect(bare.logs.text).not.toContain(user.id);
        expect(bare.logs.text).not.toContain('avatar.png');
      } finally {
        await bare.app.close();
      }
    });
  });
});
