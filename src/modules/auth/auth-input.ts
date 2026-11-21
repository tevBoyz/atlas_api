import { DomainError, type ErrorCode } from '../../common/errors';
import { normalizeE164 } from '../../common/policies';
import { requireJsonObject } from '../incidents/incident-input';
import {
  APP_VERSION_MAX,
  INSTALLATION_ID_HEADER,
  PLATFORMS,
  type Platform,
} from '../notifications/device-input';

/**
 * Request values of the auth routes (spec §11.3 A1-A20, Phase 6). Each body is checked in its field
 * order and the first failure wins, naming its field in `details.field`. A rejected value is never
 * echoed (emails, phones, passwords, tokens and codes are personal data or secrets).
 */

/** Strict `+E.164` (spec §6.3 rule 16, `complete_profile_setup`). */
export const E164 = /^\+[1-9][0-9]{7,14}$/;
/** Longest password accepted at all (policy: 8-128). Longer input is refused before any hashing. */
export const PASSWORD_INPUT_MAX = 1024;
export const PASSWORD_POLICY_MIN = 8;
export const PASSWORD_POLICY_MAX = 128;
export const FULL_NAME_MAX = 100;
export const DEVICE_NAME_MAX = 100;
/** Longest opaque token (links, refresh tokens) or ID token accepted. */
const TOKEN_MAX = 512;
const ID_TOKEN_MAX = 8192;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PRINTABLE = /^[^\p{Cc}]+$/u;
const OPAQUE = /^[A-Za-z0-9_-]+$/;
const SIGNUP_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function fail(code: ErrorCode, field: string): DomainError {
  return new DomainError(code, { details: { field } });
}

/** The device a session is opened on (`device` of every sign-in body). */
export interface DeviceInput {
  platform: Platform;
  app_version: string;
  device_name: string | null;
  /** `X-Atlas-Installation-Id` (optional): links the session to that `user_devices` row. */
  installation_id: string | null;
}

/** The optional installation id header of sign-in routes; invalid → `auth:invalid_device`. */
export function optionalInstallationId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw fail('auth:invalid_device', INSTALLATION_ID_HEADER);
  }
  return value.toLowerCase();
}

/** `device: {platform, app_version, device_name?}` (rules of `PUT /v1/me/devices/current`). */
export function deviceFrom(value: unknown, installationId: string | null): DeviceInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('auth:invalid_device', 'device');
  }
  const device = value as Record<string, unknown>;
  const platform = device.platform;
  if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) {
    throw fail('auth:invalid_device', 'device.platform');
  }
  const version = typeof device.app_version === 'string' ? device.app_version.trim() : '';
  if (!version || version.length > APP_VERSION_MAX || !PRINTABLE.test(version)) {
    throw fail('auth:invalid_device', 'device.app_version');
  }
  let name: string | null = null;
  if (device.device_name !== undefined && device.device_name !== null) {
    if (typeof device.device_name !== 'string') {
      throw fail('auth:invalid_device', 'device.device_name');
    }
    const trimmed = device.device_name.trim();
    if (trimmed.length > DEVICE_NAME_MAX || (trimmed !== '' && !PRINTABLE.test(trimmed))) {
      throw fail('auth:invalid_device', 'device.device_name');
    }
    name = trimmed || null;
  }
  return {
    platform: platform as Platform,
    app_version: version,
    device_name: name,
    installation_id: installationId,
  };
}

/** D5a: 8-128 characters with a lowercase letter, an uppercase letter and a digit. */
export function meetsPasswordPolicy(password: string): boolean {
  return (
    password.length >= PASSWORD_POLICY_MIN &&
    password.length <= PASSWORD_POLICY_MAX &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

/** A new password: a string meeting the policy, else `auth:weak_password`. */
export function newPasswordFrom(value: unknown, field: string): string {
  if (typeof value !== 'string' || !meetsPasswordPolicy(value)) {
    throw fail('auth:weak_password', field);
  }
  return value;
}

/** A sign-up / reset email: trimmed, lower-case, at most 254, `local@domain.tld`. */
export function signupEmailFrom(value: unknown, field = 'email'): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !SIGNUP_EMAIL.test(email)) {
    throw fail('auth:invalid_email', field);
  }
  return email;
}

/** A phone of the auth routes: normalized like `_normalize_e164`, then strict `+E.164`. */
export function authPhoneFrom(value: unknown, field = 'phone'): string {
  const phone = typeof value === 'string' ? normalizeE164(value) : null;
  if (!phone || !E164.test(phone)) throw fail('auth:invalid_phone', field);
  return phone;
}

function opaqueToken(value: unknown, code: ErrorCode, field: string): string {
  if (typeof value !== 'string' || value.length > TOKEN_MAX || !OPAQUE.test(value)) {
    throw fail(code, field);
  }
  return value;
}

// --- A1 sign-up -------------------------------------------------------------------------------

export interface SignupInput {
  email: string;
  password: string;
  phone: string;
  full_name: string;
  device: DeviceInput;
}

export function signupFrom(body: unknown, installationId: string | null): SignupInput {
  const input = requireJsonObject(body);
  const email = signupEmailFrom(input.email);
  const password = newPasswordFrom(input.password, 'password');
  const phone = authPhoneFrom(input.phone);
  const fullName = typeof input.full_name === 'string' ? input.full_name.trim() : '';
  if (!fullName || fullName.length > FULL_NAME_MAX || !PRINTABLE.test(fullName)) {
    throw fail('auth:invalid_full_name', 'full_name');
  }
  return {
    email,
    password,
    phone,
    full_name: fullName,
    device: deviceFrom(input.device, installationId),
  };
}

// --- A2 / A15 links -----------------------------------------------------------------------------

/** `{token, device}` of the email-link routes. A malformed token is `auth:link_invalid`. */
export function linkTokenFrom(value: unknown, field = 'token'): string {
  return opaqueToken(value, 'auth:link_invalid', field);
}

// --- A3 resend ----------------------------------------------------------------------------------

export type EmailPurpose = 'signup' | 'magic_link';

export function emailResendFrom(body: unknown): { email: string; purpose: EmailPurpose } {
  const input = requireJsonObject(body);
  const email = signupEmailFrom(input.email);
  const purpose = input.purpose ?? 'signup';
  if (purpose !== 'signup' && purpose !== 'magic_link') {
    throw new DomainError('validation:invalid_request', { details: { field: 'purpose' } });
  }
  return { email, purpose };
}

// --- A4-A6 OTP ----------------------------------------------------------------------------------

export type OtpPurpose = 'verify_phone' | 'sign_in';

export function otpPurposeFrom(value: unknown): OtpPurpose {
  if (value !== 'verify_phone' && value !== 'sign_in') {
    throw new DomainError('validation:invalid_request', { details: { field: 'purpose' } });
  }
  return value;
}

/** Six digits, else `auth:otp_invalid` (counted like a wrong code). */
export function otpCodeFrom(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]{6}$/.test(value) ? value : null;
}

// --- A7 / A8 login and lockout status (codes and order of `_login_lockout_resolve_key`) ----------

export type Identifier = { kind: 'email'; email: string } | { kind: 'phone'; phone: string };

/** `trim()` of Postgres: spaces only. */
const pgTrim = (value: string) => value.replace(/^ +| +$/g, '');

/**
 * Exactly one of `email` / `phone` (null or absent = not given), like the lockout RPCs:
 * both → `identifier_exclusive`, none → `identifier_required`; email `lower(trim())`, blank →
 * `email_required`, over 254 or not `x@y` → `invalid_email`; phone blank → `phone_required`, not
 * `+E.164` after `_normalize_e164` → `invalid_phone`. A value that is not a string is
 * `validation:invalid_request`.
 */
export function identifierFrom(email: unknown, phone: unknown): Identifier {
  const hasEmail = email !== undefined && email !== null;
  const hasPhone = phone !== undefined && phone !== null;
  if (hasEmail && typeof email !== 'string') {
    throw new DomainError('validation:invalid_request', { details: { field: 'email' } });
  }
  if (hasPhone && typeof phone !== 'string') {
    throw new DomainError('validation:invalid_request', { details: { field: 'phone' } });
  }
  if (hasEmail && hasPhone) throw fail('login_lockout:identifier_exclusive', 'email');
  if (!hasEmail && !hasPhone) throw fail('login_lockout:identifier_required', 'email');
  if (typeof email === 'string') {
    const normalized = pgTrim(email).toLowerCase();
    if (normalized === '') throw fail('login_lockout:email_required', 'email');
    if (normalized.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(normalized)) {
      throw fail('login_lockout:invalid_email', 'email');
    }
    return { kind: 'email', email: normalized };
  }
  const phoneText = typeof phone === 'string' ? phone : '';
  if (pgTrim(phoneText) === '') throw fail('login_lockout:phone_required', 'phone');
  const normalized = normalizeE164(phoneText);
  if (!normalized || !E164.test(normalized)) throw fail('login_lockout:invalid_phone', 'phone');
  return { kind: 'phone', phone: normalized };
}

export interface LoginInput {
  identifier: Identifier;
  password: string;
  device: DeviceInput;
}

export function loginFrom(body: unknown, installationId: string | null): LoginInput {
  const input = requireJsonObject(body);
  const identifier = identifierFrom(input.email, input.phone);
  const password = input.password;
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > PASSWORD_INPUT_MAX
  ) {
    throw new DomainError('validation:invalid_request', { details: { field: 'password' } });
  }
  return { identifier, password, device: deviceFrom(input.device, installationId) };
}

// --- A9 / A10 OAuth -----------------------------------------------------------------------------

export function idTokenFrom(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_TOKEN_MAX) {
    throw fail('auth:oauth_invalid_token', 'id_token');
  }
  return value;
}

/** An optional short text (Apple nonce, full name); invalid → `validation:invalid_request`. */
export function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new DomainError('validation:invalid_request', { details: { field } });
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// --- A11 refresh --------------------------------------------------------------------------------

/** A malformed refresh token is answered like an unknown one: `auth:session_expired`. */
export function refreshTokenFrom(body: unknown): string {
  const input = requireJsonObject(body);
  return opaqueToken(input.refresh_token, 'auth:session_expired', 'refresh_token');
}
