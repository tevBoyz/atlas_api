import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { authHeader } from '../../src/testing/test-tokens';

/**
 * Profile routes (API-100-34 to 37) and their direct-table / SQL counterparts, for integration and
 * parity tests. `userId: null` sends no token.
 */
const headersFor = async (userId: string | null) => (userId ? await authHeader(userId) : {});

type Method = 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';

async function send(
  app: NestFastifyApplication,
  method: Method,
  userId: string | null,
  url: string,
  body?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: {
      ...(await headersFor(userId)),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** `GET /v1/me/profile` (P1). */
export const getProfile = (app: NestFastifyApplication, userId: string | null) =>
  send(app, 'GET', userId, '/v1/me/profile');

/** The two medical lists of SCRUM-21 (D51), as their route segments. */
export type MedicalListRoute = 'allergies' | 'medical-conditions';

/** `POST /v1/me/profile/{list}` (SCRUM-21, D51). */
export const addMedicalItem = (
  app: NestFastifyApplication,
  userId: string | null,
  list: MedicalListRoute,
  body: unknown,
) => send(app, 'POST', userId, `/v1/me/profile/${list}`, body);

/** `PATCH /v1/me/profile/{list}/{item_id}`. */
export const editMedicalItem = (
  app: NestFastifyApplication,
  userId: string | null,
  list: MedicalListRoute,
  itemId: string,
  body: unknown,
) => send(app, 'PATCH', userId, `/v1/me/profile/${list}/${itemId}`, body);

/** `DELETE /v1/me/profile/{list}/{item_id}`. */
export const deleteMedicalItem = (
  app: NestFastifyApplication,
  userId: string | null,
  list: MedicalListRoute,
  itemId: string,
) => send(app, 'DELETE', userId, `/v1/me/profile/${list}/${itemId}`);

/** `PUT /v1/me/profile/personal-info` (P2). */
export const putPersonalInfo = (
  app: NestFastifyApplication,
  userId: string | null,
  body: unknown,
) => send(app, 'PUT', userId, '/v1/me/profile/personal-info', body);

/** `PUT /v1/me/profile/emergency-info` (P3). */
export const putEmergencyInfo = (
  app: NestFastifyApplication,
  userId: string | null,
  body: unknown,
) => send(app, 'PUT', userId, '/v1/me/profile/emergency-info', body);

/** `PUT /v1/me/profile/preferences` (P4). */
export const putPreferences = (app: NestFastifyApplication, userId: string | null, body: unknown) =>
  send(app, 'PUT', userId, '/v1/me/profile/preferences', body);

/** `PATCH /v1/me/profile/sharing-flags` (P5). */
export const patchSharingFlags = (
  app: NestFastifyApplication,
  userId: string | null,
  body: unknown,
) => send(app, 'PATCH', userId, '/v1/me/profile/sharing-flags', body);

/** `PATCH /v1/me/profile/location-sharing` (P6). */
export const patchLocationSharing = (
  app: NestFastifyApplication,
  userId: string | null,
  body: unknown,
) => send(app, 'PATCH', userId, '/v1/me/profile/location-sharing', body);

/** `POST /v1/me/profile/complete` (P7). */
export const completeSetup = (app: NestFastifyApplication, userId: string | null) =>
  send(app, 'POST', userId, '/v1/me/profile/complete');

/** `POST /v1/me/avatar/upload-url` (P8). */
export const createAvatarUploadUrl = (
  app: NestFastifyApplication,
  userId: string | null,
  body: unknown,
) => send(app, 'POST', userId, '/v1/me/avatar/upload-url', body);

/** `PUT /v1/me/profile/avatar` (P9). */
export const setAvatar = (app: NestFastifyApplication, userId: string | null, body: unknown) =>
  send(app, 'PUT', userId, '/v1/me/profile/avatar', body);

/** A valid Personal Info body. */
export const personalInfoBody = (overrides: Record<string, unknown> = {}) => ({
  full_name: 'Awa Example',
  date_of_birth: '1990-05-17',
  gender: 'female',
  ...overrides,
});

/** A valid Emergency Info body: every share flag off unless overridden. */
export const emergencyInfoBody = (overrides: Record<string, unknown> = {}) => ({
  emergency_contact_full_name: 'Musa Contact',
  emergency_contact_relationship: 'sibling',
  emergency_contact_phone: '+12015550188',
  emergency_contact_email: 'musa@example.test',
  blood_type: 'O+',
  allergies: 'Peanuts',
  medical_conditions: 'Asthma',
  emergency_preferred_language: 'Wolof',
  location_sharing_enabled: true,
  emergency_notes: 'Inhaler in the bag',
  emergency_notes_shareable: false,
  share_emergency_contact_full_name: false,
  share_emergency_contact_relationship: false,
  share_emergency_contact_phone: false,
  share_emergency_contact_email: false,
  share_blood_type: false,
  share_allergies: false,
  share_medical_conditions: false,
  share_emergency_preferred_language: false,
  ...overrides,
});

/** A valid Preferences body. */
export const preferencesBody = (overrides: Record<string, unknown> = {}) => ({
  alert_push_enabled: true,
  alert_email_enabled: false,
  alert_sms_enabled: true,
  location_sharing_enabled: true,
  hide_profile_from_non_members: false,
  app_language: 'en',
  timezone: 'Africa/Banjul',
  preferred_language: 'wo',
  ...overrides,
});

/**
 * Runs `statement` as the `authenticated` role with `userId`'s JWT claims in UTC: the app's direct
 * table path through PostgREST and RLS (spec §7.8). Committed unless it throws.
 */
export async function asAppUser<T extends Record<string, unknown> = Record<string, unknown>>(
  client: Client,
  userId: string,
  statement: string,
  params: unknown[] = [],
): Promise<T[]> {
  await client.query('begin');
  try {
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true),
              set_config('TimeZone', 'UTC', true)`,
      [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
    );
    await client.query('set local role authenticated');
    const { rows } = await client.query<T>(statement, params);
    await client.query('commit');
    return rows;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** The app's `fetchOwn` today: `select *` of the own row through RLS, as PostgREST's JSON text. */
export async function profileViaRls(client: Client, userId: string): Promise<string | null> {
  const rows = await asAppUser<{ body: string }>(
    client,
    userId,
    'select row_to_json(p)::text as body from public.profiles p where p.id = $1',
    [userId],
  );
  return rows[0]?.body ?? null;
}

/** An `auth.users` row without a profile (a user before Personal Info). */
export async function createAuthUser(client: Client, id: string): Promise<void> {
  await client.query(
    `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                             raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
             $2, now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now())`,
    [id, `user-${id}@example.test`],
  );
}
