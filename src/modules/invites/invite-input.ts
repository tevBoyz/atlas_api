import {
  invalidRequest,
  isPostgresText,
  isPostgresUuidInput,
  requireJsonObject,
} from '../incidents/incident-input';

/**
 * Request values of the owner invite routes (API-100-26/27/28), as PostgREST would have handed them
 * to the SQL functions (see `incident-input.ts`): a value Postgres cannot take as the argument's type
 * fails before any check of the function, with 422 `validation:invalid_request` naming the field.
 * Everything else (blank names, bad phones, unknown relationships) is the function's own check and
 * keeps its `fn:code`, in the function's order, after the owner precondition.
 */

/** Postgres `trim(text)` / `btrim(text)` with no second argument: spaces only, both ends. */
export function pgTrim(value: string): string {
  return value.replace(/^ +| +$/g, '');
}

/** The strict E.164 check of the invite functions and of `safety_circle_members_phone_e164`. */
export const INVITE_PHONE_E164 = /^\+[1-9][0-9]{7,14}$/;

/** `safety_circle_members_relationship_allowed` and the functions' list (spec §4.4). */
export const INVITE_RELATIONSHIPS: readonly string[] = [
  'spouse',
  'partner',
  'parent',
  'child',
  'sibling',
  'friend',
  'other',
];

/** Placeholder name of an unnamed link invite (`create_circle_invite_link`). */
export const LINK_INVITE_DEFAULT_NAME = 'Invited member';

/**
 * A `text` argument from the JSON body: missing or null → SQL null; a string Postgres can hold → as
 * is. Anything else → 422 on `field` (PostgREST would pass the JSON text of a number or object,
 * which is no longer known once the body is parsed; the API refuses it rather than guess).
 */
function textArgument(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isPostgresText(value)) throw invalidRequest(field);
  return value;
}

/** `POST /v1/me/circle/invites/phone` → the arguments of `invite_circle_member_by_phone`. */
export interface PhoneInviteArgs {
  displayName: string | null;
  phone: string | null;
  relationship: string | null;
}

export function phoneInviteFromBody(body: unknown): PhoneInviteArgs {
  const object = requireJsonObject(body);
  return {
    displayName: textArgument(object, 'display_name'),
    phone: textArgument(object, 'phone'),
    relationship: textArgument(object, 'relationship'),
  };
}

/**
 * `POST /v1/me/circle/invites/link` → `display_name` of `create_circle_invite_link(display_name
 * default null)`. No body at all is the call without arguments.
 */
export function linkInviteFromBody(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  return textArgument(requireJsonObject(body), 'display_name');
}

/** True when every string anywhere in `value` is text Postgres can hold (jsonb refuses `\u0000`). */
function isPostgresJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === 'string') return isPostgresText(value);
  if (Array.isArray(value)) return value.every((item) => isPostgresJson(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(
      ([key, item]) => isPostgresText(key) && isPostgresJson(item, depth + 1),
    );
  }
  return true;
}

/**
 * `POST /v1/me/circle/invites/phone/batch` → `p_invites jsonb` of `invite_circle_members_by_phone`:
 * the `invites` value exactly as sent (any JSON; missing → SQL null). Whether it is an array, and
 * every item, is the function's check (`invalid_invites`, per-item outcomes), so nothing else is
 * validated here, except text jsonb cannot hold (422 on `invites`).
 */
export function batchInvitesFromBody(body: unknown): unknown {
  const value = requireJsonObject(body).invites;
  if (value === undefined) return null;
  if (!isPostgresJson(value)) throw invalidRequest('invites');
  return value;
}

/**
 * The `{token}` path parameter of the invitee routes (`token text` of the SQL functions): any text
 * Postgres can hold, as sent (the operation trims it, as the functions do). Text Postgres cannot hold
 * (`\u0000`, an unpaired surrogate) → 422 on `token`; the value is never echoed or logged.
 */
export function requireInviteToken(value: unknown): string {
  if (typeof value !== 'string' || !isPostgresText(value)) throw invalidRequest('token');
  return value;
}

/** The `{member_id}` path parameter of resend and cancel: uuid input, else 422 on `member_id`. */
export function requireMemberId(value: unknown): string {
  if (!isPostgresUuidInput(value)) throw invalidRequest('member_id');
  return value;
}
