import { DomainError, type ErrorCode } from '../../common/errors';
import { invalidRequest, isPostgresText, requireJsonObject } from '../incidents/incident-input';
import {
  ALL_SHARE_FLAGS,
  OPTIONAL_SHARE_FLAGS,
  SHARE_FLAGS,
  type ShareFlag,
} from './profile.schemas';

/**
 * Request bodies of the profile writes (API-100-35, spec §11.3 P2-P6), checked in the body's field
 * order; the first failing check wins and names its field in `details.field` (spec §11.2, rule 57).
 *
 * - A value of the wrong JSON type (a number for a text field, a string for a flag) or text Postgres
 *   cannot hold (`\u0000`) → 422 `validation:invalid_request`, as on every other route.
 * - A text value that is missing, blank or not allowed → the field's own `profiles:*` code (422).
 * - Text is trimmed with JavaScript `trim()` (all Unicode whitespace, as the app's Dart `trim()`);
 *   optional text that is blank after trimming is stored as null (the app's `nullIfBlank`).
 *
 * Every value that passes these checks also passes the table's check constraints (spec §4.2), so a
 * valid request never reaches a 23xxx error.
 */

type Body = Record<string, unknown>;

/** `profiles_gender_allowed`. */
export const GENDERS: readonly string[] = ['female', 'male', 'prefer_not_to_say'];
/** `profiles_emergency_contact_relationship_allowed` (spec §5.1). */
export const RELATIONSHIPS: readonly string[] = [
  'spouse',
  'partner',
  'parent',
  'child',
  'sibling',
  'friend',
  'other',
];
/** `profiles_blood_type_allowed` (spec §5.1). */
export const BLOOD_TYPES: readonly string[] = [
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
  'Unknown',
];
/** `profiles_preferred_language_allowed` (spec §5.1). */
export const PREFERRED_LANGUAGES: readonly string[] = ['en', 'wo', 'mnk', 'ff'];
/** `profiles_app_language_allowed`, `profiles_timezone_allowed`. */
export const APP_LANGUAGE = 'en';
export const TIMEZONE = 'Africa/Banjul';
/** `profiles_emergency_notes_length` (`char_length`, i.e. characters, not UTF-16 units). */
export const EMERGENCY_NOTES_MAX = 500;
/**
 * The phone rule of `complete_profile_setup` (`^\+[1-9][0-9]{7,14}$`): a number the API stores can
 * always complete setup. Stricter than the app's own check (`^\+[1-9]\d{6,14}$`), see the hand-off.
 */
export const E164 = /^\+[1-9][0-9]{7,14}$/;
/** The app's email rule (`identifiers.dart`), after trimming. */
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

function fail(code: ErrorCode, field: string): DomainError {
  return new DomainError(code, { details: { field } });
}

/** A text field: undefined (left out), null, or a string Postgres can hold. Else 422 on `field`. */
function text(body: Body, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !isPostgresText(value)) throw invalidRequest(field);
  return value;
}

/** Required non-blank text, trimmed; missing, null or blank → `code`. */
function requiredText(body: Body, field: string, code: ErrorCode): string {
  const value = text(body, field)?.trim();
  if (!value) throw fail(code, field);
  return value;
}

/** Optional text, trimmed; left out, null or blank → null. */
function optionalText(body: Body, field: string): string | null {
  return text(body, field)?.trim() || null;
}

/** A required JSON boolean, else 422 `validation:invalid_request` on `field`. */
function flag(body: Body, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') throw invalidRequest(field);
  return value;
}

/** Characters as Postgres `char_length` counts them (code points). */
export function charLength(value: string): number {
  return [...value].length;
}

/** `YYYY-MM-DD` that Postgres reads as the same calendar date (year 0001-9999). */
export function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * An object path in the caller's own folder of the `avatars` bucket: `{uid}/<name>`, where the first
 * folder is the caller's id as Storage compares it (`storage.foldername(name)[1] = auth.uid()::text`,
 * lowercase text) and every following segment is a plain file or folder name (no `.`/`..`, no empty
 * segment). Today's paths (`{uid}/avatar.jpg`) and the API's (`{uid}/avatar-{uuid}.jpg`) qualify.
 */
export function isOwnAvatarPath(path: string, callerId: string): boolean {
  const segments = path.split('/');
  if (segments.length < 2 || segments[0] !== callerId.toLowerCase()) return false;
  if (path.length > 1024) return false;
  return segments
    .slice(1)
    .every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

/** `undefined` = leave the stored value; `null` = clear it. */
export type Keep<T> = T | undefined;

/** `PUT /v1/me/profile/personal-info` (P2). */
export interface PersonalInfoInput {
  fullName: string;
  dateOfBirth: string;
  gender: Keep<string | null>;
  avatarPath: Keep<string | null>;
}

/**
 * P2 in field order: `full_name` (trimmed, not blank), `date_of_birth` (a real `YYYY-MM-DD` not
 * after `today`, the database's current date in UTC = Africa/Banjul), `gender` (left out = keep,
 * null = clear, else one of 3 values), `avatar_path` (left out = keep, null = clear, else a path in
 * the caller's own folder).
 */
export function personalInfoFromBody(
  raw: unknown,
  callerId: string,
  today: string,
): PersonalInfoInput {
  const body = requireJsonObject(raw);
  const fullName = requiredText(body, 'full_name', 'profiles:invalid_full_name');

  const dob = text(body, 'date_of_birth');
  if (!dob || !isCalendarDate(dob) || dob > today) {
    throw fail('profiles:invalid_date_of_birth', 'date_of_birth');
  }

  const gender = text(body, 'gender');
  if (typeof gender === 'string' && !GENDERS.includes(gender)) {
    throw fail('profiles:invalid_gender', 'gender');
  }

  const avatarPath = text(body, 'avatar_path');
  if (typeof avatarPath === 'string' && !isOwnAvatarPath(avatarPath, callerId)) {
    throw fail('profiles:invalid_avatar_path', 'avatar_path');
  }

  return { fullName, dateOfBirth: dob, gender, avatarPath };
}

/** `PUT /v1/me/profile/emergency-info` (P3). Column name → value, in the body's order. */
export type EmergencyInfoInput = Record<string, string | boolean | null>;

/**
 * P3 in field order (spec §11.3 P3): contact name (trimmed, not blank), relationship (one of 7),
 * phone (trimmed, strict E.164; no country code is added), email (optional, the app's rule), blood
 * type (optional, one of 9), preferred language (optional text; `allergies` / `medical_conditions`
 * are ignored since SCRUM-21, D51),
 * `location_sharing_enabled`, notes (optional, at most 500 characters), then the 9 share flags, then
 * `share_phone` (SCRUM-52, D59): optional, left out keeps the stored value, else a JSON boolean.
 */
export function emergencyInfoFromBody(raw: unknown): EmergencyInfoInput {
  const body = requireJsonObject(raw);
  const values: EmergencyInfoInput = {};

  values.emergency_contact_full_name = requiredText(
    body,
    'emergency_contact_full_name',
    'profiles:invalid_emergency_contact_full_name',
  );

  const relationship = text(body, 'emergency_contact_relationship');
  if (!relationship || !RELATIONSHIPS.includes(relationship)) {
    throw fail('profiles:invalid_relationship', 'emergency_contact_relationship');
  }
  values.emergency_contact_relationship = relationship;

  const phone = text(body, 'emergency_contact_phone')?.trim();
  if (!phone || !E164.test(phone)) throw fail('profiles:invalid_phone', 'emergency_contact_phone');
  values.emergency_contact_phone = phone;

  const email = optionalText(body, 'emergency_contact_email');
  if (email !== null && !EMAIL.test(email)) {
    throw fail('profiles:invalid_email', 'emergency_contact_email');
  }
  values.emergency_contact_email = email;

  const bloodType = optionalText(body, 'blood_type');
  if (bloodType !== null && !BLOOD_TYPES.includes(bloodType)) {
    throw fail('profiles:invalid_blood_type', 'blood_type');
  }
  values.blood_type = bloodType;

  // `allergies` / `medical_conditions` are not read (SCRUM-21, D51): the item lists own those columns
  // (`/v1/me/profile/allergies`, `/v1/me/profile/medical-conditions`); sent values are ignored.
  values.emergency_preferred_language = optionalText(body, 'emergency_preferred_language');
  values.location_sharing_enabled = flag(body, 'location_sharing_enabled');

  const notes = optionalText(body, 'emergency_notes');
  if (notes !== null && charLength(notes) > EMERGENCY_NOTES_MAX) {
    throw fail('profiles:emergency_notes_too_long', 'emergency_notes');
  }
  values.emergency_notes = notes;

  for (const name of SHARE_FLAGS) values[name] = flag(body, name);
  for (const name of OPTIONAL_SHARE_FLAGS) {
    if (body[name] !== undefined) values[name] = flag(body, name);
  }
  return values;
}

/** `PUT /v1/me/profile/preferences` (P4). Column name → value. */
export type PreferencesInput = Record<string, string | boolean>;

/**
 * P4 in field order: the 5 booleans, `app_language` (`en` only), `timezone` (`Africa/Banjul` only),
 * `preferred_language` (one of 4). The three text fields are compared as sent (no trimming: they are
 * codes, not typed text).
 */
export function preferencesFromBody(raw: unknown): PreferencesInput {
  const body = requireJsonObject(raw);
  const values: PreferencesInput = {};
  for (const name of [
    'alert_push_enabled',
    'alert_email_enabled',
    'alert_sms_enabled',
    'location_sharing_enabled',
    'hide_profile_from_non_members',
  ]) {
    values[name] = flag(body, name);
  }
  if (text(body, 'app_language') !== APP_LANGUAGE) {
    throw fail('profiles:invalid_app_language', 'app_language');
  }
  values.app_language = APP_LANGUAGE;
  if (text(body, 'timezone') !== TIMEZONE) throw fail('profiles:invalid_timezone', 'timezone');
  values.timezone = TIMEZONE;
  const language = text(body, 'preferred_language');
  if (!language || !PREFERRED_LANGUAGES.includes(language)) {
    throw fail('profiles:invalid_preferred_language', 'preferred_language');
  }
  values.preferred_language = language;
  return values;
}

/**
 * `PATCH /v1/me/profile/sharing-flags` (P5): the flags present in the body (any subset of the 9
 * plus `share_phone`, D59), each a JSON boolean. Other keys are ignored; nothing else is written.
 */
export function sharingFlagsFromBody(raw: unknown): Partial<Record<ShareFlag, boolean>> {
  const body = requireJsonObject(raw);
  const values: Partial<Record<ShareFlag, boolean>> = {};
  for (const name of ALL_SHARE_FLAGS) {
    if (body[name] !== undefined) values[name] = flag(body, name);
  }
  return values;
}

/** `PATCH /v1/me/profile/location-sharing` (P6): `{enabled: boolean}`. */
export function locationSharingFromBody(raw: unknown): boolean {
  return flag(requireJsonObject(raw), 'enabled');
}
