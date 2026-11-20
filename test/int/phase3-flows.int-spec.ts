import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AVATAR_STORAGE, type AvatarStorage } from '../../src/modules/profiles/avatar-storage';
import type { MemoryAvatarStorage } from '../../src/modules/profiles/memory-avatar-storage';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { getOwnCircle } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  completeSetup,
  createAuthUser,
  createAvatarUploadUrl,
  emergencyInfoBody,
  getProfile,
  patchLocationSharing,
  patchSharingFlags,
  personalInfoBody,
  preferencesBody,
  putEmergencyInfo,
  putPersonalInfo,
  putPreferences,
  setAvatar,
} from '../support/profile-api';

/**
 * API-100-38 AC1-AC4: the app's onboarding and Settings flows end to end through the API (spec §6.1
 * rules 1-6a, §10.2), each step checked in the database.
 *
 * - AC1 onboarding: Personal Info (with a photo) → Emergency Info → Preferences → Complete → the
 *   circle, the owner row and the emergency contact's invite exist with exactly these columns.
 * - AC2 deferred: Complete with Location Sharing off → no circle; turn it on → Complete → circle.
 * - AC3 Settings edits do not change any completion timestamp.
 * - AC4 photo round trip with the Storage fake; the URL format of today.
 */
type Body = Record<string, unknown>;

const SUPABASE_URL = 'https://example-project.supabase.co';

describe('Phase 3 gate: onboarding and Settings through the API (API-100-38)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let storage: MemoryAvatarStorage;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        SUPABASE_URL,
        AVATAR_STORAGE: 'memory',
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
      }),
    ));
    storage = app.get<AvatarStorage>(AVATAR_STORAGE) as MemoryAvatarStorage;
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  const newUser = async () => {
    const id = randomUUID();
    await createAuthUser(client, id);
    return id;
  };

  const timestamps = async (id: string) =>
    (
      await client.query<Body>(
        `select personal_info_completed_at::text as personal, emergency_info_completed_at::text as emergency,
                preferences_completed_at::text as preferences, profile_setup_completed_at::text as setup,
                created_at::text as created
           from public.profiles where id = $1`,
        [id],
      )
    ).rows[0];

  /** Photo upload as the app will do it: upload-url, PUT the bytes, returns the object path. */
  const uploadPhoto = async (id: string) => {
    const signed = (
      await createAvatarUploadUrl(app, id, { content_type: 'image/jpeg', content_length: 2048 })
    ).json<Body>();
    const url = new URL(signed.upload_url as string);
    const put = await app.inject({
      method: 'PUT',
      url: `${url.pathname}${url.search}`,
      headers: signed.headers as Record<string, string>,
      payload: Buffer.alloc(2048, 7),
    });
    expect(put.statusCode).toBe(200);
    return signed.object_path as string;
  };

  it('AC1 onboarding: personal → emergency → preferences → complete → circle, owner row, contact invite (exact columns)', async () => {
    const id = await newUser();
    const photo = await uploadPhoto(id);
    expect(
      (
        await putPersonalInfo(
          app,
          id,
          personalInfoBody({ full_name: ' Awa Example ', avatar_path: photo }),
        )
      ).statusCode,
    ).toBe(200);
    expect((await putEmergencyInfo(app, id, emergencyInfoBody())).statusCode).toBe(200);
    expect((await putPreferences(app, id, preferencesBody())).statusCode).toBe(200);
    const done = await completeSetup(app, id);
    expect(done.statusCode).toBe(200);
    const result = done.json<Body>();
    expect(result).toMatchObject({ location_sharing_enabled: true, member_status: 'pending' });

    const circle = (
      await client.query<Body>(
        `select id::text, owner_id::text, name, created_at = updated_at as untouched
           from public.safety_circles where owner_id = $1`,
        [id],
      )
    ).rows;
    expect(circle).toEqual([
      { id: result.circle_id, owner_id: id, name: 'My Safety Circle', untouched: true },
    ]);

    const rows = (
      await client.query<Body>(
        `select m.role, m.status, m.display_name, m.relationship, m.phone, m.email,
                m.user_id::text as user_id, m.invite_token ~ '^[0-9a-f]{64}$' as token_ok,
                m.invite_token is null as no_token,
                m.invite_expires_at - m.invited_at as lifetime,
                m.invite_canceled_at, m.invite_consumed_at,
                m.activated_at is not null as activated, m.activated_at = m.invited_at as trigger_time,
                m.invited_at = p.profile_setup_completed_at as same_transaction
           from public.safety_circle_members m
           join public.profiles p on p.id = $2
          where m.circle_id = $1
          order by m.role desc`,
        [result.circle_id, id],
      )
    ).rows;
    expect(rows).toEqual([
      {
        role: 'owner',
        status: 'active',
        display_name: 'Awa Example',
        relationship: null,
        phone: null,
        email: null,
        user_id: id,
        token_ok: null,
        no_token: true,
        lifetime: null,
        invite_canceled_at: null,
        invite_consumed_at: null,
        activated: true,
        trigger_time: true,
        same_transaction: true,
      },
      {
        role: 'member',
        status: 'pending',
        display_name: 'Musa Contact',
        relationship: 'sibling',
        phone: '+12015550188',
        email: 'musa@example.test',
        user_id: null,
        token_ok: true,
        no_token: false,
        lifetime: { days: 7 },
        invite_canceled_at: null,
        invite_consumed_at: null,
        activated: false,
        trigger_time: null,
        same_transaction: true,
      },
    ]);
    expect((await getOwnCircle(app, id)).json<Body>()).toMatchObject({
      capacity: { used: 1, available: 4 },
    });
    const profile = (await getProfile(app, id)).json<Body>();
    expect(profile).toMatchObject({
      full_name: 'Awa Example',
      avatar_path: photo,
      avatar_url: `${SUPABASE_URL}/storage/v1/object/public/avatars/${photo}`,
      profile_setup_completed_at: result.profile_setup_completed_at,
    });
    for (const key of [
      'personal_info_completed_at',
      'emergency_info_completed_at',
      'preferences_completed_at',
    ]) {
      expect(profile[key]).toEqual(expect.any(String));
    }
  });

  it('AC2 deferred: complete with sharing off → no circle; turn it on → complete → circle', async () => {
    const id = await newUser();
    await putPersonalInfo(app, id, personalInfoBody());
    await putEmergencyInfo(app, id, emergencyInfoBody({ location_sharing_enabled: false }));
    await putPreferences(app, id, preferencesBody({ location_sharing_enabled: false }));
    const off = (await completeSetup(app, id)).json<Body>();
    expect(off).toMatchObject({
      location_sharing_enabled: false,
      circle_id: null,
      member_id: null,
      member_status: null,
    });
    expect((await getOwnCircle(app, id)).json<Body>()).toEqual({
      circle: null,
      members: [],
      capacity: null,
    });
    // Settings → Location Access On (rule 6a): P6 then P7.
    await patchLocationSharing(app, id, { enabled: true });
    const on = (await completeSetup(app, id)).json<Body>();
    expect(on).toMatchObject({ location_sharing_enabled: true, member_status: 'pending' });
    expect(on.profile_setup_completed_at).toBe(off.profile_setup_completed_at);
    const own = (await getOwnCircle(app, id)).json<{ circle: Body; members: Body[] }>();
    expect(own.circle.id).toBe(on.circle_id);
    expect(own.members.map((m) => [m.role, m.status])).toEqual([
      ['owner', 'active'],
      ['member', 'pending'],
    ]);
  });

  it('AC3 Settings edits (all five writes and a photo change) keep every completion timestamp', async () => {
    const id = await newUser();
    await putPersonalInfo(app, id, personalInfoBody());
    await putEmergencyInfo(app, id, emergencyInfoBody());
    await putPreferences(app, id, preferencesBody());
    await completeSetup(app, id);
    const before = await timestamps(id);
    await putPersonalInfo(app, id, personalInfoBody({ full_name: 'Edited Name', gender: null }));
    await putEmergencyInfo(app, id, emergencyInfoBody({ blood_type: null, allergies: 'None' }));
    await putPreferences(app, id, preferencesBody({ preferred_language: 'ff' }));
    await patchSharingFlags(app, id, { share_blood_type: true, emergency_notes_shareable: true });
    await patchLocationSharing(app, id, { enabled: false });
    await patchLocationSharing(app, id, { enabled: true });
    await completeSetup(app, id);
    await setAvatar(app, id, { object_path: await uploadPhoto(id) });
    expect(await timestamps(id)).toEqual(before);
  });

  it('AC4 photo round trip with the Storage fake; the public URL format of today', async () => {
    const id = await newUser();
    await putPersonalInfo(app, id, personalInfoBody());
    const first = await uploadPhoto(id);
    expect(storage.get(first)).toEqual({ contentType: 'image/jpeg', size: 2048 });
    const set = (await setAvatar(app, id, { object_path: first })).json<Body>();
    expect(set.avatar_url).toBe(`${SUPABASE_URL}/storage/v1/object/public/avatars/${first}`);
    const second = await uploadPhoto(id);
    await setAvatar(app, id, { object_path: second });
    expect(await storage.exists(first)).toBe(false);
    expect((await getProfile(app, id)).json<Body>().avatar_url).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/avatars/${second}`,
    );
    const removed = (await setAvatar(app, id, { object_path: null })).json<Body>();
    expect(removed).toMatchObject({ avatar_path: null, avatar_url: null });
    expect(await storage.exists(second)).toBe(false);
  });
});
