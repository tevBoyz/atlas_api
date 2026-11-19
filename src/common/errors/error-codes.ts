/**
 * Error code catalogue (story API-100-05).
 *
 * Parity codes are the `fn:code` strings today's SQL functions raise (spec §7), grouped by prefix
 * (the SQL function name, or `login_lockout` for the three lockout functions, spec §7.5). The app
 * matches on these strings, so they are frozen: never rename one. New codes are added by the story
 * that introduces the operation.
 *
 * Generic codes are API-only: they cover failures that have no SQL equivalent (unknown route,
 * unreadable body, request validation without a parity code, unexpected errors).
 */
export const PARITY_ERROR_CODES = {
  // §7.1 Profile
  complete_profile_setup: [
    'not_authenticated',
    'profile_not_found',
    'personal_info_incomplete',
    'emergency_info_incomplete',
    'preferences_incomplete',
    // Caught by the SQL since 2026-11-17 (setup succeeds); kept because §11.3 P7 lists it and the
    // raw trigger `circle_full` maps to it if the API ever lets it surface.
    'circle_full',
  ],

  // §7.2 Circles and invites (owner side)
  circle_invite_capacity: ['not_authenticated', 'not_owner'],
  invite_circle_member_by_phone: [
    'not_authenticated',
    'profile_not_found',
    'location_sharing_disabled',
    'circle_not_found',
    'invalid_display_name',
    'invalid_phone',
    'invalid_relationship',
    'already_active',
    'circle_full',
    'duplicate_membership',
  ],
  invite_circle_members_by_phone: [
    'not_authenticated',
    'profile_not_found',
    'location_sharing_disabled',
    'circle_not_found',
    'invalid_invites',
  ],
  create_circle_invite_link: [
    'not_authenticated',
    'profile_not_found',
    'location_sharing_disabled',
    'circle_not_found',
    'circle_full',
  ],
  resend_circle_invite: [
    'not_authenticated',
    'profile_not_found',
    'location_sharing_disabled',
    'circle_not_found',
    'member_not_found',
    'not_invitable',
    'already_active',
    'circle_full',
    'invalid_display_name',
  ],
  cancel_circle_invite: [
    'not_authenticated',
    'not_found',
    'not_authorized',
    'cannot_cancel_owner',
    'not_pending',
  ],
  remove_circle_member: ['not_authenticated', 'not_found', 'not_authorized', 'cannot_remove_owner'],
  list_circle_members: ['not_authenticated', 'not_found', 'not_authorized'],

  // §7.3 Circles and invites (invitee / member side). lookup_circle_invite raises no errors.
  preview_circle_invite: ['not_authenticated', 'duplicate_membership'],
  accept_circle_invite: [
    'not_authenticated',
    'not_found',
    'expired',
    'consumed',
    'canceled',
    'not_recipient',
    'own_circle',
    'already_member',
    'circle_full',
    'duplicate_membership',
  ],
  decline_circle_invite: [
    'not_authenticated',
    'not_found',
    'expired',
    'consumed',
    'canceled',
    'not_recipient',
  ],
  list_my_circle_invites: ['not_authenticated'],
  list_my_joined_circles: ['not_authenticated'],
  leave_safety_circle: ['not_authenticated', 'not_found', 'is_owner', 'not_authorized'],

  // §7.4 Incidents
  submit_emergency_alert: [
    'not_authenticated',
    'invalid_type',
    'profile_not_found',
    'profile_setup_incomplete',
  ],
  get_my_open_incident: ['not_authenticated'],
  list_my_recent_incidents: ['not_authenticated'],
  attach_incident_location: [
    'not_authenticated',
    'invalid_source',
    'invalid_location',
    'not_found',
    'not_open',
  ],
  get_live_location_config: ['not_authenticated'],
  renotify_emergency_alert: ['not_authenticated', 'not_found', 'not_open'],
  set_incident_notes: ['not_authenticated', 'not_found', 'not_open', 'too_long'],
  mark_incident_safe: ['not_authenticated', 'not_found', 'not_open'],
  incident_delivery_counts: ['not_authenticated', 'not_found'],
  acknowledge_incident: ['not_authenticated', 'not_found', 'not_open'],
  list_responder_incidents: ['not_authenticated'],
  get_incident_details: ['not_authenticated', 'not_found'],
  // §11.3 E11 `GET /v1/incidents/{id}/events` (API-100-22): new code, no SQL function behind it.
  incident_events: ['not_authenticated', 'not_found'],

  // §7.5 Login lockout (prefix `login_lockout`, not the function name)
  login_lockout: [
    'rate_limited',
    'identifier_exclusive',
    'identifier_required',
    'email_required',
    'invalid_email',
    'phone_required',
    'invalid_phone',
    'locked',
    'not_authenticated',
    'email_mismatch',
  ],

  // §11.2 / §11.3 E1 Idempotency-Key (enforced by API-100-10; `invalid_key` from its AC3)
  idempotency: ['key_mismatch', 'in_progress', 'key_required', 'invalid_key'],
} as const;

type ParityCatalogue = typeof PARITY_ERROR_CODES;

/** A prefix (`fn`) of the parity catalogue. */
export type ErrorPrefix = keyof ParityCatalogue;

/** Every parity `fn:code` string. */
export type ParityErrorCode = {
  [P in ErrorPrefix]: `${P}:${ParityCatalogue[P][number]}`;
}[ErrorPrefix];

/** The code part after `fn:` of any parity code. */
export type ErrorSuffix = ParityCatalogue[ErrorPrefix][number];

/**
 * API-only codes. Each has a fixed HTTP status (see `http-status.ts`):
 * - `validation:invalid_request` (422) request validation failed and the operation has no parity code (AC4).
 * - `internal:error` (500) anything unexpected (AC5).
 * - `http:*` framework-level failures before any operation runs (unknown route, unreadable body, ...).
 * - `rate_limit:exceeded` (429) a rate limit was hit and the operation has no code of its own (API-100-11).
 */
export const GENERIC_ERROR_CODES = [
  'validation:invalid_request',
  'internal:error',
  'http:bad_request',
  'http:unauthorized',
  'http:forbidden',
  'http:not_found',
  'http:method_not_allowed',
  'http:not_acceptable',
  'http:request_timeout',
  'http:conflict',
  'http:gone',
  'http:length_required',
  'http:payload_too_large',
  'http:uri_too_long',
  'http:unsupported_media_type',
  'http:too_many_requests',
  'http:client_error',
  'rate_limit:exceeded',
] as const;

export type GenericErrorCode = (typeof GENERIC_ERROR_CODES)[number];

/** Any code the API may put in the error envelope. */
export type ErrorCode = ParityErrorCode | GenericErrorCode;

/** Every parity code as a flat list, in catalogue order. */
export const ALL_PARITY_ERROR_CODES: readonly ParityErrorCode[] = (
  Object.entries(PARITY_ERROR_CODES) as [ErrorPrefix, readonly string[]][]
).flatMap(([prefix, suffixes]) =>
  suffixes.map((suffix) => `${prefix}:${suffix}` as ParityErrorCode),
);

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
  ...ALL_PARITY_ERROR_CODES,
  ...GENERIC_ERROR_CODES,
]);

/** True when `value` is a code from the catalogue (parity or generic). */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value);
}

/**
 * `prefix:suffix` when the catalogue lists that suffix for the prefix, else undefined. For codes
 * built from a route's `@Operation` (e.g. `<fn>:not_authenticated`, `<fn>:not_found`).
 */
export function parityCode(prefix: ErrorPrefix, suffix: string): ParityErrorCode | undefined {
  const suffixes: readonly string[] = PARITY_ERROR_CODES[prefix];
  return suffixes.includes(suffix) ? (`${prefix}:${suffix}` as ParityErrorCode) : undefined;
}

/** Splits `fn:code` into its prefix and suffix. */
export function splitCode(code: string): { prefix: string; suffix: string } {
  const index = code.indexOf(':');
  return index < 0
    ? { prefix: '', suffix: code }
    : { prefix: code.slice(0, index), suffix: code.slice(index + 1) };
}
