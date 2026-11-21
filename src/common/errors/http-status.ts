import { type GenericErrorCode, splitCode } from './error-codes';

/**
 * Central code → HTTP status table (spec §11.2, story API-100-05 AC2).
 *
 * Lookup order: an exact full code (`login_lockout:locked`, `idempotency:*`, generic codes) wins,
 * then the code suffix (the part after `fn:`) is matched against the §11.2 rows.
 * `undefined` means the code is not mapped: the exception filter treats that as a programming
 * error and answers 500 `internal:error`.
 */

/** Full codes with their own status (§11.2 rows naming a whole code, §11.3 E1, generic codes). */
export const FULL_CODE_STATUS: Readonly<Record<string, number>> = {
  'login_lockout:locked': 423,
  // Own authentication (§11.3 A1-A20, Phase 6): every `auth:*` code by its full name, so suffixes
  // such as `invalid_credentials` (not a 422) never fall into a generic row.
  'auth:not_authenticated': 401,
  'auth:invalid_email': 422,
  'auth:invalid_phone': 422,
  'auth:invalid_full_name': 422,
  'auth:invalid_device': 422,
  'auth:weak_password': 422,
  'auth:same_password': 422,
  'auth:link_invalid': 400,
  'auth:link_expired': 410,
  'auth:over_email_send_rate_limit': 429,
  'auth:otp_resend_limit': 429,
  'auth:otp_invalid': 400,
  'auth:otp_expired': 410,
  'auth:otp_invalidated': 423,
  'auth:sms_unavailable': 503,
  'auth:invalid_credentials': 401,
  'auth:email_not_confirmed': 403,
  'auth:phone_not_confirmed': 403,
  'auth:user_disabled': 403,
  'auth:oauth_invalid_token': 401,
  'auth:identity_conflict': 409,
  'auth:provider_disabled': 503,
  'auth:provider_unavailable': 503,
  'auth:session_expired': 401,
  'auth:refresh_token_reused': 401,
  'auth:session_not_found': 404,
  'auth:exchange_not_allowed': 403,
  'auth:session_already_exchanged': 409,
  'idempotency:key_mismatch': 422,
  'idempotency:in_progress': 409,
  'idempotency:key_required': 400,
  'idempotency:invalid_key': 422,
  'validation:invalid_request': 422,
  'internal:error': 500,
  'http:bad_request': 400,
  'http:unauthorized': 401,
  'http:forbidden': 403,
  'http:not_found': 404,
  'http:method_not_allowed': 405,
  'http:not_acceptable': 406,
  'http:request_timeout': 408,
  'http:conflict': 409,
  'http:gone': 410,
  'http:length_required': 411,
  'http:payload_too_large': 413,
  'http:uri_too_long': 414,
  'http:unsupported_media_type': 415,
  'http:too_many_requests': 429,
  'http:client_error': 400,
  'rate_limit:exceeded': 429,
} satisfies Record<
  GenericErrorCode | `idempotency:${string}` | 'login_lockout:locked' | `auth:${string}`,
  number
>;

/** §11.2 rows matched on the exact suffix. */
export const SUFFIX_STATUS: Readonly<Record<string, number>> = {
  not_authenticated: 401,

  not_authorized: 403,
  not_owner: 403,
  not_recipient: 403,
  email_mismatch: 403,

  not_found: 404,
  member_not_found: 404,
  profile_not_found: 404,
  circle_not_found: 404,

  too_long: 422,
  email_required: 422,
  phone_required: 422,
  // `profiles:*` (API-100-35/37): request values without an `invalid_*` name.
  emergency_notes_too_long: 422,
  file_too_large: 422,
  // `profiles:avatar_not_found` (API-100-37): the object to set as the photo is not in Storage.
  avatar_not_found: 404,
  // `profiles:avatar_storage_unavailable` (API-100-37): Storage is not configured or not answering.
  avatar_storage_unavailable: 503,

  already_active: 409,
  already_member: 409,
  already_pending: 409,
  duplicate_membership: 409,
  circle_full: 409,
  consumed: 409,
  canceled: 409,
  not_pending: 409,
  not_open: 409,
  own_circle: 409,
  is_owner: 409,
  cannot_remove_owner: 409,
  cannot_cancel_owner: 409,
  not_invitable: 409,
  location_sharing_disabled: 409,
  profile_setup_incomplete: 409,

  expired: 410,

  rate_limited: 429,
};

/** §11.2 wildcard rows (`invalid_*`, `identifier_*`, `*_incomplete`), checked after exact suffixes. */
export const SUFFIX_PATTERN_STATUS: readonly { pattern: RegExp; status: number }[] = [
  { pattern: /^invalid_[a-z0-9_]+$/, status: 422 },
  { pattern: /^identifier_[a-z0-9_]+$/, status: 422 },
  { pattern: /^[a-z0-9_]+_incomplete$/, status: 409 },
];

/** HTTP status for an error code, or `undefined` when the table has no row for it. */
export function httpStatusForCode(code: string): number | undefined {
  const exact = FULL_CODE_STATUS[code];
  if (exact !== undefined) return exact;
  const { suffix } = splitCode(code);
  const bySuffix = SUFFIX_STATUS[suffix];
  if (bySuffix !== undefined) return bySuffix;
  return SUFFIX_PATTERN_STATUS.find(({ pattern }) => pattern.test(suffix))?.status;
}

/** Generic code for a 4xx raised by the framework (Nest/Fastify) rather than by a domain rule. */
export function genericCodeForStatus(status: number): GenericErrorCode {
  switch (status) {
    case 400:
      return 'http:bad_request';
    case 401:
      return 'http:unauthorized';
    case 403:
      return 'http:forbidden';
    case 404:
      return 'http:not_found';
    case 405:
      return 'http:method_not_allowed';
    case 406:
      return 'http:not_acceptable';
    case 408:
      return 'http:request_timeout';
    case 409:
      return 'http:conflict';
    case 410:
      return 'http:gone';
    case 411:
      return 'http:length_required';
    case 413:
      return 'http:payload_too_large';
    case 414:
      return 'http:uri_too_long';
    case 415:
      return 'http:unsupported_media_type';
    case 422:
      return 'validation:invalid_request';
    case 429:
      return 'http:too_many_requests';
    default:
      return 'http:client_error';
  }
}
