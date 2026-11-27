import type { MemberDelivery } from './incident-delivery-status';
import type { ResponderRow, ResponderStatus } from './incident-responders.repository';

/** Who is looking at a responder row: the incident's resident, or a member (their own user id). */
export type ResponderViewer = { resident: true } | { resident: false; viewerId: string };

/**
 * One responder row as one caller sees it (D56, D79), keys in this order: `user_id`, `handle`,
 * `display_name`, `avatar_url`, `status`, `acknowledged_at`, `status_at`, `is_me`.
 * - D79 (Stage 3 [IDS], replaces D11 masking here): `user_id` is the caller's OWN id on their own
 *   row and null on every other row (the resident's rows are all null: a resident is never a
 *   recipient of their own alert). No other user's id, full or masked, is ever sent.
 * - `handle`: the member's membership row id (opaque, not derived from the user id, the same for
 *   every viewer): the key to match rows, `incident.responders` updates and event actors by.
 * - `is_me`: the row is the caller's own.
 * - SCRUM-65 (D73): the RESIDENT's rows also carry, after `is_me`, `delivery_status`
 *   (`sent` | `delivered` | `failed`), `delivery_at` and `delivery_failed_reason` (`no_device` |
 *   `failed` | null). A member's rows never do (exactly the 8 keys above).
 * Nothing else of the row (no phone, email or other profile field) exists to leak.
 */
export function responderView(row: ResponderRow, viewer: { resident: true }): ResidentResponderView;
export function responderView(row: ResponderRow, viewer: ResponderViewer): ResponderView;
export function responderView(row: ResponderRow, viewer: ResponderViewer): ResponderView {
  const isMe = !viewer.resident && row.user_id.toLowerCase() === viewer.viewerId.toLowerCase();
  const base: MemberResponderView = {
    user_id: isMe ? row.user_id.toLowerCase() : null,
    handle: row.handle,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    status: row.status,
    acknowledged_at: row.acknowledged_at,
    status_at: row.status_at,
    is_me: isMe,
  };
  if (!viewer.resident) return base;
  return {
    ...base,
    delivery_status: row.delivery_status,
    delivery_at: row.delivery_at,
    delivery_failed_reason: row.delivery_failed_reason,
  };
}

/** A responder row as a member sees it (D56, D79): exactly 8 keys. */
export interface MemberResponderView {
  /** D79: the caller's own id on their own row, else null. */
  user_id: string | null;
  /** D79: the membership row id. */
  handle: string;
  display_name: string;
  avatar_url: string | null;
  status: ResponderStatus;
  acknowledged_at: string | null;
  status_at: string | null;
  is_me: boolean;
}

/** A responder row as the resident sees it: the 7 keys plus the delivery status (D73). */
export type ResidentResponderView = MemberResponderView & MemberDelivery;

export type ResponderView = MemberResponderView | ResidentResponderView;
