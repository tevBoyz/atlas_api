import {
  ALL_PARITY_ERROR_CODES,
  GENERIC_ERROR_CODES,
  isErrorCode,
  type ErrorCode,
} from './error-codes';
import { messageForCode } from './error-messages';
import { DomainError } from './domain-error';
import { genericCodeForStatus, httpStatusForCode } from './http-status';

/**
 * Spec §11.2 "HTTP status mapping for existing codes", one test per row and per name in the row
 * (story API-100-05 DoD: unit test for every mapping row).
 */
describe('§11.2 code → HTTP status table', () => {
  describe('row: not_authenticated → 401', () => {
    it.each([
      'submit_emergency_alert:not_authenticated',
      'list_circle_members:not_authenticated',
      'login_lockout:not_authenticated',
    ])('%s', (code) => expect(httpStatusForCode(code)).toBe(401));
  });

  describe('row: not_authorized, not_owner, not_recipient, email_mismatch → 403', () => {
    it.each([
      'remove_circle_member:not_authorized',
      'circle_invite_capacity:not_owner',
      'accept_circle_invite:not_recipient',
      'login_lockout:email_mismatch',
    ])('%s', (code) => expect(httpStatusForCode(code)).toBe(403));
  });

  describe('row: not_found, member_not_found, profile_not_found, circle_not_found → 404', () => {
    it.each([
      'mark_incident_safe:not_found',
      'resend_circle_invite:member_not_found',
      'submit_emergency_alert:profile_not_found',
      'create_circle_invite_link:circle_not_found',
    ])('%s', (code) => expect(httpStatusForCode(code)).toBe(404));
  });

  describe('row: invalid_*, too_long, identifier_*, email_required, phone_required → 422', () => {
    it.each([
      'submit_emergency_alert:invalid_type',
      'attach_incident_location:invalid_source',
      'attach_incident_location:invalid_location',
      'invite_circle_member_by_phone:invalid_phone',
      'invite_circle_members_by_phone:invalid_invites',
      'login_lockout:invalid_email',
      'set_incident_notes:too_long',
      'login_lockout:identifier_exclusive',
      'login_lockout:identifier_required',
      'login_lockout:email_required',
      'login_lockout:phone_required',
    ])('%s', (code) => expect(httpStatusForCode(code)).toBe(422));
  });

  describe('row: conflicts (already_*, circle_full, not_open, *_incomplete, ...) → 409', () => {
    it.each([
      'invite_circle_member_by_phone:already_active',
      'accept_circle_invite:already_member',
      'bulk_invite:already_pending',
      'accept_circle_invite:duplicate_membership',
      'accept_circle_invite:circle_full',
      'accept_circle_invite:consumed',
      'accept_circle_invite:canceled',
      'cancel_circle_invite:not_pending',
      'mark_incident_safe:not_open',
      'accept_circle_invite:own_circle',
      'leave_safety_circle:is_owner',
      'remove_circle_member:cannot_remove_owner',
      'cancel_circle_invite:cannot_cancel_owner',
      'resend_circle_invite:not_invitable',
      'create_circle_invite_link:location_sharing_disabled',
      'submit_emergency_alert:profile_setup_incomplete',
      'complete_profile_setup:personal_info_incomplete',
      'complete_profile_setup:emergency_info_incomplete',
      'complete_profile_setup:preferences_incomplete',
    ])('%s', (code) => expect(httpStatusForCode(code)).toBe(409));
  });

  describe('row: expired (accept/decline) → 410', () => {
    it.each(['accept_circle_invite:expired', 'decline_circle_invite:expired'])('%s', (code) =>
      expect(httpStatusForCode(code)).toBe(410),
    );
  });

  it('row: login_lockout:locked → 423', () => {
    expect(httpStatusForCode('login_lockout:locked')).toBe(423);
  });

  it('row: rate_limited → 429', () => {
    expect(httpStatusForCode('login_lockout:rate_limited')).toBe(429);
  });

  it('row: idempotency key reused with a different body → 422 idempotency:key_mismatch', () => {
    expect(httpStatusForCode('idempotency:key_mismatch')).toBe(422);
  });

  it('row: same key still in flight → 409 idempotency:in_progress', () => {
    expect(httpStatusForCode('idempotency:in_progress')).toBe(409);
  });

  it('§11.3 E1: missing Idempotency-Key → 400 idempotency:key_required', () => {
    expect(httpStatusForCode('idempotency:key_required')).toBe(400);
  });

  it('API-100-10 AC3: Idempotency-Key not a UUID → 422 idempotency:invalid_key', () => {
    expect(httpStatusForCode('idempotency:invalid_key')).toBe(422);
  });

  it('a full-code row wins over its suffix (locked is not a generic suffix)', () => {
    expect(httpStatusForCode('some_fn:locked')).toBeUndefined();
  });

  it('returns undefined for a code with no row', () => {
    expect(httpStatusForCode('fn:something_new')).toBeUndefined();
    expect(httpStatusForCode('circle_full_but_not_really')).toBeUndefined();
  });
});

describe('catalogue completeness', () => {
  it('has the codes of spec §7 (spot checks per section)', () => {
    for (const code of [
      'complete_profile_setup:preferences_incomplete',
      'invite_circle_member_by_phone:duplicate_membership',
      'resend_circle_invite:not_invitable',
      'preview_circle_invite:duplicate_membership',
      'leave_safety_circle:is_owner',
      'acknowledge_incident:not_open',
      'get_incident_details:not_found',
      'login_lockout:locked',
    ]) {
      expect(isErrorCode(code)).toBe(true);
    }
    expect(isErrorCode('cancel_circle_invite:expired')).toBe(false); // retired 2026-11-17 (§7.2)
  });

  it.each(ALL_PARITY_ERROR_CODES.map((code) => [code]))(
    '%s has an HTTP status and a message',
    (code) => {
      const status = httpStatusForCode(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(messageForCode(code)).toMatch(/^[A-Z].*\.$/);
    },
  );

  it.each(GENERIC_ERROR_CODES.map((code) => [code]))('%s has a status and a message', (code) => {
    expect(httpStatusForCode(code)).toBeGreaterThanOrEqual(400);
    expect(messageForCode(code)).toMatch(/^[A-Z].*\.$/);
  });

  it('generic statuses: validation 422, internal 500, http:* by name', () => {
    expect(httpStatusForCode('validation:invalid_request')).toBe(422);
    expect(httpStatusForCode('internal:error')).toBe(500);
    expect(httpStatusForCode('http:not_found')).toBe(404);
    expect(httpStatusForCode('http:payload_too_large')).toBe(413);
    expect(httpStatusForCode('http:unsupported_media_type')).toBe(415);
  });

  it('every message is plain text without placeholders', () => {
    const all: ErrorCode[] = [...ALL_PARITY_ERROR_CODES, ...GENERIC_ERROR_CODES];
    for (const code of all) {
      expect(messageForCode(code)).not.toMatch(/[{}<>$%]|undefined/);
    }
  });
});

describe('genericCodeForStatus (framework 4xx)', () => {
  it.each([
    [400, 'http:bad_request'],
    [401, 'http:unauthorized'],
    [403, 'http:forbidden'],
    [404, 'http:not_found'],
    [405, 'http:method_not_allowed'],
    [413, 'http:payload_too_large'],
    [415, 'http:unsupported_media_type'],
    [422, 'validation:invalid_request'],
    [429, 'http:too_many_requests'],
    [418, 'http:client_error'],
  ])('%i → %s', (status, code) => {
    expect(genericCodeForStatus(status)).toBe(code);
  });
});

describe('DomainError', () => {
  it('carries code, status, fixed message and details', () => {
    const error = new DomainError('attach_incident_location:invalid_source', {
      details: { field: 'location_source' },
    });
    expect(error.code).toBe('attach_incident_location:invalid_source');
    expect(error.status).toBe(422);
    expect(error.message).toBe('The location source is not valid.');
    expect(error.details).toEqual({ field: 'location_source' });
  });

  it('defaults details to {}', () => {
    expect(new DomainError('mark_incident_safe:not_open').details).toEqual({});
  });

  it('refuses a code without a mapping (cast past the type)', () => {
    expect(() => new DomainError('fn:unmapped' as ErrorCode)).toThrow(/without an HTTP status/);
  });
});
