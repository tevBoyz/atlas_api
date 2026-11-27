import { createHash } from 'node:crypto';

import { DomainError, type ErrorCode } from '../../common/errors';
import { requireJsonObject } from '../incidents/incident-input';

/**
 * Request values of the device routes (API-100-44, spec §11.3 U1/U2, decision D22). Checked in this
 * order, the first failure wins and names its field in `details.field`; a rejected value is never
 * echoed (push tokens are credentials).
 *
 * 1. `X-Atlas-Installation-Id`: a UUID in the canonical 8-4-4-4-12 form (either case; stored in
 *    lowercase). Missing or anything else → 422 `user_devices:invalid_installation_id`.
 * 2. The body (U1 only): a JSON object, else 422 `validation:invalid_request` on field `body`; then
 *    `platform`, `app_version`, `push_provider`, `push_token` in that order, each with its own code.
 *
 * `push_provider` / `push_token`: left out (both) = keep what is stored; `null` = clear the token;
 * a token always comes with its provider (and a provider with its token).
 *
 * `time_zone` (Stage 2 [TZ]): optional IANA zone; left out = keep the stored zone; anything that is
 * not a known zone is stored as null, never refused.
 */

export const INSTALLATION_ID_HEADER = 'x-atlas-installation-id';

export const PLATFORMS = ['android', 'ios'] as const;
export const PUSH_PROVIDERS = ['fcm', 'apns'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type PushProvider = (typeof PUSH_PROVIDERS)[number];

/** Longest `app_version` (characters after trimming). */
export const APP_VERSION_MAX = 64;
/** Longest push token. FCM registration tokens are about 160 characters, APNs tokens 64 hex. */
export const PUSH_TOKEN_MAX = 4096;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Printable text without control characters. */
const PRINTABLE = /^[^\p{Cc}]+$/u;
/** Visible ASCII, no spaces: what FCM and APNs tokens are made of. */
const TOKEN = /^[\x21-\x7E]+$/;

/** What `PUT /v1/me/devices/current` stores. `push` undefined = keep the stored token. */
export interface DeviceRegistration {
  platform: Platform;
  app_version: string;
  push?: { provider: PushProvider; token: string } | null;
  /**
   * Stage 2 [TZ]: the installation's IANA time zone. Undefined (left out) = keep the stored zone;
   * null = none (sent as null, or not a known IANA zone: stored null, never an error).
   */
  time_zone?: string | null;
}

/** Longest `time_zone` accepted (IANA names are at most about 30 characters). */
export const TIME_ZONE_MAX = 64;
/** An IANA zone name: `Area/Location[/Sub]`, or a single name such as `UTC`. No offsets. */
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*){0,2}$/;

/**
 * Stage 2 [TZ]: the zone to store for a `time_zone` value: the name when it is a time zone this
 * runtime knows (IANA), else null. Never throws.
 */
export function knownTimeZone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const zone = value.trim();
  if (!zone || zone.length > TIME_ZONE_MAX || !IANA_ZONE.test(zone)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * D69 (gap 49): what U1 says about this installation's push token.
 * - `ok`: a token is stored;
 * - `none`: no token was sent and none is stored (or the body cleared it);
 * - `invalid`: the token sent is the one the provider last answered `unregistered` for on this
 *   device. It was not stored; the app must get a brand-new token.
 */
export const PUSH_TOKEN_STATUSES = ['ok', 'none', 'invalid'] as const;
export type PushTokenStatus = (typeof PUSH_TOKEN_STATUSES)[number];

/** The status of U1 from what the write found (`refused`) and left stored (`stored`). */
export function pushTokenStatus(outcome: { refused: boolean; stored: boolean }): PushTokenStatus {
  if (outcome.refused) return 'invalid';
  return outcome.stored ? 'ok' : 'none';
}

/**
 * D69: SHA-256 (lowercase hex) of a push token, kept in `user_devices.push_token_invalid_hash` for
 * the token the provider answered `unregistered` for. Never logged.
 */
export function pushTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function fail(code: ErrorCode, field: string): DomainError {
  return new DomainError(code, { details: { field } });
}

/** The installation id header, lowercase. A repeated header is refused (Fastify joins it). */
export function requireInstallationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw fail('user_devices:invalid_installation_id', INSTALLATION_ID_HEADER);
  }
  return value.toLowerCase();
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** The U1 body, checked in field order. */
export function deviceRegistrationFromBody(body: unknown): DeviceRegistration {
  const input = requireJsonObject(body);

  const platform = input.platform;
  if (!isOneOf(PLATFORMS, platform)) throw fail('user_devices:invalid_platform', 'platform');

  const rawVersion = input.app_version;
  const appVersion = typeof rawVersion === 'string' ? rawVersion.trim() : '';
  if (!appVersion || appVersion.length > APP_VERSION_MAX || !PRINTABLE.test(appVersion)) {
    throw fail('user_devices:invalid_app_version', 'app_version');
  }

  const provider = input.push_provider;
  if (provider !== undefined && provider !== null && !isOneOf(PUSH_PROVIDERS, provider)) {
    throw fail('user_devices:invalid_push_provider', 'push_provider');
  }

  const token = input.push_token;
  if (
    token !== undefined &&
    token !== null &&
    (typeof token !== 'string' || token.length > PUSH_TOKEN_MAX || !TOKEN.test(token))
  ) {
    throw fail('user_devices:invalid_push_token', 'push_token');
  }

  // A token needs its provider, and a provider needs its token.
  if (typeof token === 'string' && typeof provider !== 'string') {
    throw fail('user_devices:invalid_push_provider', 'push_provider');
  }
  if (typeof provider === 'string' && typeof token !== 'string') {
    throw fail('user_devices:invalid_push_token', 'push_token');
  }

  const registration: DeviceRegistration = { platform, app_version: appVersion };
  // [TZ]: never refused; an unknown zone is stored as null.
  if (input.time_zone !== undefined) registration.time_zone = knownTimeZone(input.time_zone);
  if (typeof token === 'string' && typeof provider === 'string') {
    registration.push = { provider, token };
  } else if (token === null || provider === null) {
    registration.push = null;
  }
  return registration;
}
