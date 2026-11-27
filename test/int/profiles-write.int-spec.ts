import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AvatarNames } from '../../src/modules/profiles/avatar-names';
import { PROFILE_COLUMNS } from '../../src/modules/profiles/profiles.repository';
import { SHARE_FLAGS } from '../../src/modules/profiles/profile.schemas';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { errorOf } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { goneUser } from '../support/test-sessions';
import {
  createAuthUser,
  emergencyInfoBody,
  getProfile,
  patchLocationSharing,
  patchSharingFlags,
  personalInfoBody,
  preferencesBody,
  putEmergencyInfo,
  putPersonalInfo,
  putPreferences,
} from '../support/profile-api';

/**
 * API-100-35: the five profile writes (spec §11.3 P2-P6) against the app's direct `profiles` writes
 * of today (spec §7.8) and the table's rules (spec §4.2).
 *
 * - AC1 personal info: creates the row; trims the name; future dates refused; gender values; the
 *   photo path must be in the caller's folder; `personal_info_completed_at` set by the server once.
 * - AC2 emergency info: required contact fields, strict E.164, relationship / blood type lists,
 *   notes <= 500 characters, blank → null, the 9 flags and location sharing; completion set once.
 * - AC3 preferences: `en`, `Africa/Banjul`, the 4 languages; completion set once.
 * - AC4 sharing flags: any subset, nothing else touched. AC5 location sharing.
 * - AC6 no request can write a completion timestamp or `profile_setup_completed_at`; Settings edits
 *   never reset one.
 * - AC7 each returns the full Profile (= `GET /v1/me/profile`); 404 for P3-P6 without a row.
 * - Parity: for the same values, the stored row equals what today's direct table write (through
 *   RLS, as the app does it) stores, except the completion timestamps the server now owns.
 */
type Body = Record<string, unknown>;

const SERVER_OWNED = [
  'personal_info_completed_at',
  'preferences_completed_at',
  'emergency_info_completed_at',
  'profile_setup_completed_at',
] as const;

const SPOOFED = Object.fromEntries(
  [...SERVER_OWNED, 'created_at', 'updated_at'].map((column) => [column, '2000-01-01T00:00:00Z']),
);

describe('profile writes (API-100-35)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        SUPABASE_URL: 'https://example-project.supabase.co',
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
      }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  const row = async (id: string): Promise<Body> =>
    (
      await client.query<Body>(
        `select p.*, p.date_of_birth::text as date_of_birth,
                (select now()) as db_now
           from public.profiles p where p.id = $1`,
        [id],
      )
    ).rows[0];

  const newAuthUser = async () => {
    const id = randomUUID();
    await createAuthUser(client, id);
    return id;
  };

  /** A user with a profile and no completion timestamps. */
  const freshProfile = async () => {
    const id = await newAuthUser();
    await client.query(
      `insert into public.profiles (id, full_name, date_of_birth) values ($1, 'Fresh User', '1990-01-01')`,
      [id],
    );
    return id;
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

  describe('AC1 PUT /v1/me/profile/personal-info', () => {
    it('creates the row (table defaults), trims the name and stamps personal_info_completed_at', async () => {
      const id = await newAuthUser();
      // D79: a photo path the API issued to the caller (random name, no user id).
      const photo = app.get(AvatarNames).newPath(id, 'jpg');
      const reply = await putPersonalInfo(
        app,
        id,
        personalInfoBody({ full_name: '  Awa  Example ', avatar_path: photo }),
      );
      expect(reply.statusCode).toBe(200);
      const body = reply.json<Body>();
      const stored = await row(id);
      expect(body).toMatchObject({
        id,
        full_name: 'Awa  Example',
        date_of_birth: '1990-05-17',
        gender: 'female',
        avatar_path: photo,
        avatar_url: `https://example-project.supabase.co/storage/v1/object/public/avatars/${photo}`,
        alert_push_enabled: true,
        location_sharing_enabled: true,
        app_language: 'en',
        timezone: 'Africa/Banjul',
        preferred_language: 'en',
        preferences_completed_at: null,
        emergency_info_completed_at: null,
        profile_setup_completed_at: null,
      });
      expect(stored.personal_info_completed_at).toEqual(stored.created_at);
      // AC7: the same body as GET.
      expect(reply.body).toBe((await getProfile(app, id)).body);
    });

    it('keeps the first completion time and leaves gender / avatar_path alone when left out', async () => {
      const id = await newAuthUser();
      const photo = app.get(AvatarNames).newPath(id, 'png');
      await putPersonalInfo(app, id, personalInfoBody({ avatar_path: photo }));
      const first = (await row(id)).personal_info_completed_at;
      const reply = await putPersonalInfo(app, id, {
        full_name: 'Renamed',
        date_of_birth: '1991-02-03',
        ...SPOOFED,
      });
      expect(reply.statusCode).toBe(200);
      const after = await row(id);
      expect(after.personal_info_completed_at).toEqual(first);
      expect(after).toMatchObject({
        full_name: 'Renamed',
        date_of_birth: '1991-02-03',
        gender: 'female',
        avatar_path: photo,
        profile_setup_completed_at: null,
      });
      // null clears both.
      await putPersonalInfo(app, id, personalInfoBody({ gender: null, avatar_path: null }));
      expect(await row(id)).toMatchObject({ gender: null, avatar_path: null });
    });

    it('refuses blank names, future or impossible dates, unknown genders and foreign photo paths', async () => {
      const id = await newAuthUser();
      const other = randomUUID();
      const today = (await row(await freshProfile())).db_now as Date;
      const todayText = today.toISOString().slice(0, 10);
      const tomorrow = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10);
      expectError(
        await putPersonalInfo(app, id, personalInfoBody({ full_name: ' \t ' })),
        422,
        'profiles:invalid_full_name',
        'full_name',
      );
      for (const dob of [tomorrow, '2023-02-29', '1990-1-1']) {
        expectError(
          await putPersonalInfo(app, id, personalInfoBody({ date_of_birth: dob })),
          422,
          'profiles:invalid_date_of_birth',
          'date_of_birth',
        );
      }
      expectError(
        await putPersonalInfo(app, id, personalInfoBody({ gender: 'other' })),
        422,
        'profiles:invalid_gender',
        'gender',
      );
      expectError(
        await putPersonalInfo(app, id, personalInfoBody({ avatar_path: `${other}/avatar.jpg` })),
        422,
        'profiles:invalid_avatar_path',
        'avatar_path',
      );
      expectError(
        await putPersonalInfo(app, id, personalInfoBody({ date_of_birth: 19900101 })),
        422,
        'validation:invalid_request',
        'date_of_birth',
      );
      expect(
        (await client.query('select 1 from public.profiles where id = $1', [id])).rowCount,
      ).toBe(0);
      // Today itself is allowed (not in the future).
      expect(
        (await putPersonalInfo(app, id, personalInfoBody({ date_of_birth: todayText }))).statusCode,
      ).toBe(200);
    });

    it('Stage 3 [B2] (SCRUM-17): date of birth optional — left out, null or blank saves; left out keeps, null clears; profile set-up still completes', async () => {
      const id = await newAuthUser();
      const withoutDob = { full_name: 'Awa Example', gender: 'female' };
      const created = await putPersonalInfo(app, id, withoutDob);
      expect(created.statusCode).toBe(200);
      expect(created.json<{ date_of_birth: unknown }>().date_of_birth).toBeNull();
      const set = await putPersonalInfo(app, id, personalInfoBody({ date_of_birth: '1990-05-17' }));
      expect(set.json<{ date_of_birth: unknown }>().date_of_birth).toBe('1990-05-17');
      const kept = await putPersonalInfo(app, id, withoutDob);
      expect(kept.json<{ date_of_birth: unknown }>().date_of_birth).toBe('1990-05-17');
      for (const cleared of [null, '', '  ']) {
        await putPersonalInfo(app, id, personalInfoBody({ date_of_birth: '1990-05-17' }));
        const res = await putPersonalInfo(app, id, personalInfoBody({ date_of_birth: cleared }));
        expect([res.statusCode, res.json<{ date_of_birth: unknown }>().date_of_birth]).toEqual([
          200,
          null,
        ]);
      }
      const { rows } = await client.query<{ dob: string | null; done: boolean }>(
        'select date_of_birth::text as dob, personal_info_completed_at is not null as done from public.profiles where id = $1',
        [id],
      );
      expect(rows).toEqual([{ dob: null, done: true }]);
    });

    it('a token whose user no longer exists → 401 profiles:not_authenticated (no 23503)', async () => {
      expectError(
        await putPersonalInfo(app, await goneUser(client), personalInfoBody()),
        401,
        'profiles:not_authenticated',
      );
    });
  });

  describe('AC2 PUT /v1/me/profile/emergency-info', () => {
    it('Stage 3 [B5] (SCRUM-79): one emergency contact only — a second save replaces it; a contact list is refused and nothing is written', async () => {
      const id = await freshProfile();
      await putEmergencyInfo(app, id, emergencyInfoBody({ emergency_contact_full_name: 'First' }));
      const second = await putEmergencyInfo(
        app,
        id,
        emergencyInfoBody({
          emergency_contact_full_name: 'Second',
          emergency_contact_phone: '+2207009911',
        }),
      );
      expect(second.statusCode).toBe(200);
      expect(second.json<Record<string, unknown>>()).toMatchObject({
        emergency_contact_full_name: 'Second',
        emergency_contact_phone: '+2207009911',
      });
      const list = await putEmergencyInfo(
        app,
        id,
        emergencyInfoBody({
          emergency_contact_full_name: 'Third',
          emergency_contacts: [
            { full_name: 'Third', phone: '+2207009912' },
            { full_name: 'Fourth', phone: '+2207009913' },
          ],
        }),
      );
      expectError(list, 422, 'validation:invalid_request', 'emergency_contacts');
      const { rows } = await client.query<{ name: string }>(
        'select emergency_contact_full_name as name from public.profiles where id = $1',
        [id],
      );
      expect(rows).toEqual([{ name: 'Second' }]);
    });

    it('stores the values, blank → null, every flag, location sharing; completion once', async () => {
      const id = await freshProfile();
      const reply = await putEmergencyInfo(
        app,
        id,
        emergencyInfoBody({
          emergency_contact_full_name: ' Musa Contact ',
          emergency_contact_email: '  ',
          medical_conditions: '',
          emergency_notes: '😀'.repeat(500),
          location_sharing_enabled: false,
          share_allergies: true,
          emergency_notes_shareable: true,
          ...SPOOFED,
        }),
      );
      expect(reply.statusCode).toBe(200);
      const stored = await row(id);
      expect(stored).toMatchObject({
        emergency_contact_full_name: 'Musa Contact',
        emergency_contact_relationship: 'sibling',
        emergency_contact_phone: '+12015550188',
        emergency_contact_email: null,
        blood_type: 'O+',
        // SCRUM-21 (D51): the PUT no longer writes these; the item lists own them.
        allergies: null,
        medical_conditions: null,
        emergency_preferred_language: 'Wolof',
        location_sharing_enabled: false,
        emergency_notes: '😀'.repeat(500),
        emergency_notes_shareable: true,
        share_allergies: true,
        share_blood_type: false,
        personal_info_completed_at: null,
        preferences_completed_at: null,
        profile_setup_completed_at: null,
      });
      expect(stored.emergency_info_completed_at).toBeInstanceOf(Date);
      expect(reply.body).toBe((await getProfile(app, id)).body);
      const first = stored.emergency_info_completed_at;
      await putEmergencyInfo(app, id, emergencyInfoBody({ allergies: 'Dust' }));
      expect((await row(id)).emergency_info_completed_at).toEqual(first);
    });

    it('each field rule with its code and field', async () => {
      const id = await freshProfile();
      const cases: [Body, string, string][] = [
        [
          { emergency_contact_full_name: '' },
          'profiles:invalid_emergency_contact_full_name',
          'emergency_contact_full_name',
        ],
        [
          { emergency_contact_relationship: 'cousin' },
          'profiles:invalid_relationship',
          'emergency_contact_relationship',
        ],
        [
          { emergency_contact_phone: '2203000001' },
          'profiles:invalid_phone',
          'emergency_contact_phone',
        ],
        [{ emergency_contact_email: 'a@b' }, 'profiles:invalid_email', 'emergency_contact_email'],
        [{ blood_type: 'AB' }, 'profiles:invalid_blood_type', 'blood_type'],
        [
          { emergency_notes: 'n'.repeat(501) },
          'profiles:emergency_notes_too_long',
          'emergency_notes',
        ],
        [
          { share_medical_conditions: 'yes' },
          'validation:invalid_request',
          'share_medical_conditions',
        ],
      ];
      for (const [overrides, code, field] of cases) {
        expectError(
          await putEmergencyInfo(app, id, emergencyInfoBody(overrides)),
          422,
          code,
          field,
        );
      }
      expect((await row(id)).emergency_contact_phone).toBeNull();
    });

    it('404 profiles:profile_not_found without a row (after the body checks)', async () => {
      const id = await newAuthUser();
      expectError(
        await putEmergencyInfo(app, id, emergencyInfoBody()),
        404,
        'profiles:profile_not_found',
      );
      expectError(
        await putEmergencyInfo(app, id, emergencyInfoBody({ blood_type: 'X' })),
        422,
        'profiles:invalid_blood_type',
        'blood_type',
      );
    });
  });

  describe('AC3 PUT /v1/me/profile/preferences', () => {
    it('stores the 8 values and stamps preferences_completed_at once', async () => {
      const id = await freshProfile();
      const reply = await putPreferences(app, id, preferencesBody({ ...SPOOFED }));
      expect(reply.statusCode).toBe(200);
      const stored = await row(id);
      expect(stored).toMatchObject({
        alert_push_enabled: true,
        alert_email_enabled: false,
        alert_sms_enabled: true,
        location_sharing_enabled: true,
        hide_profile_from_non_members: false,
        app_language: 'en',
        timezone: 'Africa/Banjul',
        preferred_language: 'wo',
        personal_info_completed_at: null,
        profile_setup_completed_at: null,
      });
      const first = stored.preferences_completed_at;
      expect(first).toBeInstanceOf(Date);
      await putPreferences(app, id, preferencesBody({ preferred_language: 'ff' }));
      expect(await row(id)).toMatchObject({
        preferences_completed_at: first,
        preferred_language: 'ff',
      });
    });

    it('only en / Africa/Banjul / the 4 languages', async () => {
      const id = await freshProfile();
      expectError(
        await putPreferences(app, id, preferencesBody({ app_language: 'fr' })),
        422,
        'profiles:invalid_app_language',
        'app_language',
      );
      expectError(
        await putPreferences(app, id, preferencesBody({ timezone: 'Europe/London' })),
        422,
        'profiles:invalid_timezone',
        'timezone',
      );
      expectError(
        await putPreferences(app, id, preferencesBody({ preferred_language: 'fr' })),
        422,
        'profiles:invalid_preferred_language',
        'preferred_language',
      );
      expectError(
        await putPreferences(app, await newAuthUser(), preferencesBody()),
        404,
        'profiles:profile_not_found',
      );
    });
  });

  describe('AC4 PATCH /v1/me/profile/sharing-flags and AC5 PATCH /v1/me/profile/location-sharing', () => {
    it('changes only the flags sent', async () => {
      const id = await freshProfile();
      await putEmergencyInfo(app, id, emergencyInfoBody());
      const before = await row(id);
      const reply = await patchSharingFlags(app, id, {
        share_blood_type: true,
        emergency_notes_shareable: true,
        allergies: 'ignored',
        ...SPOOFED,
      });
      expect(reply.statusCode).toBe(200);
      const after = await row(id);
      for (const column of PROFILE_COLUMNS) {
        if (column === 'updated_at') continue;
        const expected =
          column === 'share_blood_type' || column === 'emergency_notes_shareable'
            ? true
            : before[column];
        expect({ column, value: after[column] }).toEqual({ column, value: expected });
      }
      expect(reply.body).toBe((await getProfile(app, id)).body);
      // All 9 at once, and none (a no-op that still answers the Profile).
      const all = Object.fromEntries(SHARE_FLAGS.map((f) => [f, true]));
      expect((await patchSharingFlags(app, id, all)).json<Body>()).toMatchObject(all);
      expect((await patchSharingFlags(app, id, {})).statusCode).toBe(200);
      expectError(
        await patchSharingFlags(app, id, { share_allergies: 1 }),
        422,
        'validation:invalid_request',
        'share_allergies',
      );
      expectError(
        await patchSharingFlags(app, await newAuthUser(), { share_allergies: true }),
        404,
        'profiles:profile_not_found',
      );
    });

    it('location sharing: only that column', async () => {
      const id = await freshProfile();
      const before = await row(id);
      const reply = await patchLocationSharing(app, id, { enabled: false, ...SPOOFED });
      expect(reply.json<Body>().location_sharing_enabled).toBe(false);
      const after = await row(id);
      for (const column of PROFILE_COLUMNS) {
        if (column === 'updated_at' || column === 'location_sharing_enabled') continue;
        expect({ column, value: after[column] }).toEqual({ column, value: before[column] });
      }
      expectError(
        await patchLocationSharing(app, id, { enabled: 'false' }),
        422,
        'validation:invalid_request',
        'enabled',
      );
      expectError(
        await patchLocationSharing(app, id, {}),
        422,
        'validation:invalid_request',
        'enabled',
      );
      expectError(
        await patchLocationSharing(app, await newAuthUser(), { enabled: true }),
        404,
        'profiles:profile_not_found',
      );
    });
  });

  describe('AC6 completion timestamps are server-owned and never reset by Settings edits', () => {
    it('a complete onboarding, then every Settings edit: all four timestamps keep their values', async () => {
      const id = await newAuthUser();
      await putPersonalInfo(app, id, personalInfoBody());
      await putEmergencyInfo(app, id, emergencyInfoBody());
      await putPreferences(app, id, preferencesBody());
      await client.query(
        `update public.profiles set profile_setup_completed_at = now() - interval '1 day' where id = $1`,
        [id],
      );
      const before = await row(id);
      for (const column of SERVER_OWNED) expect(before[column]).toBeInstanceOf(Date);
      await putPersonalInfo(app, id, personalInfoBody({ full_name: 'Edited', ...SPOOFED }));
      await putEmergencyInfo(app, id, emergencyInfoBody({ allergies: null, ...SPOOFED }));
      await putPreferences(app, id, preferencesBody({ alert_sms_enabled: false, ...SPOOFED }));
      await patchSharingFlags(app, id, { share_allergies: true, ...SPOOFED });
      await patchLocationSharing(app, id, { enabled: false, ...SPOOFED });
      await patchLocationSharing(app, id, { enabled: true, ...SPOOFED });
      const after = await row(id);
      for (const column of SERVER_OWNED) {
        expect({ column, value: after[column] }).toEqual({ column, value: before[column] });
      }
      expect(after.created_at).toEqual(before.created_at);
    });
  });
});
