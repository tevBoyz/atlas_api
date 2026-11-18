import { type ErrorCode, type ErrorSuffix, type GenericErrorCode, splitCode } from './error-codes';

/**
 * Envelope `message` texts (story API-100-05 AC6): plain English, fixed strings, never built from
 * request data, so they cannot carry personal data. The app matches on `code`, not on these.
 */
const SUFFIX_MESSAGES: Record<ErrorSuffix, string> = {
  not_authenticated: 'Sign in to continue.',
  not_authorized: 'You do not have access to this.',
  not_owner: 'Only the circle owner can do this.',
  not_recipient: 'This invitation was sent to someone else.',
  email_mismatch: 'The email does not match your account.',

  not_found: 'Not found.',
  member_not_found: 'Member not found.',
  profile_not_found: 'Profile not found.',
  circle_not_found: 'Safety Circle not found.',

  invalid_type: 'Choose a valid emergency type.',
  invalid_source: 'The location source is not valid.',
  invalid_location: 'The location is not valid.',
  invalid_display_name: 'Enter a valid name.',
  invalid_phone: 'Enter a valid phone number.',
  invalid_relationship: 'Choose a valid relationship.',
  invalid_invites: 'The invitation list is not valid.',
  invalid_email: 'Enter a valid email address.',
  too_long: 'The text is too long.',
  identifier_exclusive: 'Use either an email address or a phone number, not both.',
  identifier_required: 'Enter an email address or a phone number.',
  email_required: 'Enter an email address.',
  phone_required: 'Enter a phone number.',

  already_active: 'This person is already in the Safety Circle.',
  already_member: 'You are already a member of this Safety Circle.',
  duplicate_membership: 'This person is already linked to this Safety Circle.',
  circle_full: 'This Safety Circle is full.',
  consumed: 'This invitation has already been used.',
  canceled: 'This invitation is no longer available.',
  not_pending: 'This invitation is no longer pending.',
  not_open: 'This alert is no longer open.',
  own_circle: 'This is your own Safety Circle.',
  is_owner: 'The circle owner cannot leave their own Safety Circle.',
  cannot_remove_owner: 'The circle owner cannot be removed.',
  cannot_cancel_owner: 'The circle owner cannot be canceled.',
  not_invitable: 'This member cannot be invited.',
  location_sharing_disabled: 'Turn on location sharing to manage your Safety Circle.',
  profile_setup_incomplete: 'Finish setting up your profile first.',
  personal_info_incomplete: 'Finish your personal information first.',
  emergency_info_incomplete: 'Finish your emergency information first.',
  preferences_incomplete: 'Finish your preferences first.',

  expired: 'This invitation has expired.',
  locked: 'Too many failed sign-in attempts. Try again later.',
  rate_limited: 'Too many requests. Try again later.',

  key_mismatch: 'This Idempotency-Key was already used with a different request.',
  in_progress: 'A request with this Idempotency-Key is still being processed.',
  key_required: 'An Idempotency-Key header is required.',
  invalid_key: 'The Idempotency-Key header must be a UUID.',
};

const GENERIC_MESSAGES: Record<GenericErrorCode, string> = {
  'validation:invalid_request': 'The request is not valid.',
  'internal:error': 'Something went wrong. Try again later.',
  'http:bad_request': 'The request could not be read.',
  'http:unauthorized': 'Sign in to continue.',
  'http:forbidden': 'You do not have access to this.',
  'http:not_found': 'Not found.',
  'http:method_not_allowed': 'This method is not allowed here.',
  'http:not_acceptable': 'The requested response format is not available.',
  'http:request_timeout': 'The request took too long.',
  'http:conflict': 'The request conflicts with the current state.',
  'http:gone': 'This is no longer available.',
  'http:length_required': 'The request needs a Content-Length header.',
  'http:payload_too_large': 'The request body is too large.',
  'http:uri_too_long': 'The request address is too long.',
  'http:unsupported_media_type': 'This content type is not supported.',
  'http:too_many_requests': 'Too many requests. Try again later.',
  'rate_limit:exceeded': 'Too many requests. Try again later.',
  'http:client_error': 'The request could not be processed.',
};

/** The fixed message for a code. */
export function messageForCode(code: ErrorCode): string {
  if (code in GENERIC_MESSAGES) return GENERIC_MESSAGES[code as GenericErrorCode];
  const { suffix } = splitCode(code);
  return SUFFIX_MESSAGES[suffix as ErrorSuffix] ?? GENERIC_MESSAGES['http:client_error'];
}
