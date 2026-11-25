import { maskActorId } from './incident-actor-mask';
import type { MemberDelivery } from './incident-delivery-status';
import type { ResponderRow, ResponderStatus } from './incident-responders.repository';

/** Who is looking at a responder row: the incident's resident, or a member (their own user id). */
export type ResponderViewer = { resident: true } | { resident: false; viewerId: string };

/**
 * One responder row as one caller sees it (D56), keys in this order: `user_id`, `display_name`,
 * `avatar_url`, `status`, `acknowledged_at`, `status_at`, `is_me`.
 * - The resident gets every `user_id` in full (as D11 gives the resident full ids).
 * - A member gets other members' `user_id` masked exactly as D11 masks `actor_id`
 *   ({@link maskActorId}: first 4 and last 4 hex characters, the rest `*`, hyphens kept) and their
 *   own in full.
 * - `is_me`: the row is the caller's own (always false for the resident: a resident is never a
 *   recipient of their own alert).
 * - SCRUM-65 (D73): the RESIDENT's rows also carry, after `is_me`, `delivery_status`
 *   (`sent` | `delivered` | `failed`), `delivery_at` and `delivery_failed_reason` (`no_device` |
 *   `failed` | null). A member's rows never do (exactly the 7 keys above).
 * Nothing else of the row (no phone, email or other profile field) exists to leak.
 */
export function responderView(row: ResponderRow, viewer: { resident: true }): ResidentResponderView;
export function responderView(row: ResponderRow, viewer: ResponderViewer): ResponderView;
export function responderView(row: ResponderRow, viewer: ResponderViewer): ResponderView {
  const isMe = !viewer.resident && row.user_id.toLowerCase() === viewer.viewerId.toLowerCase();
  const base: MemberResponderView = {
    user_id: viewer.resident ? row.user_id : maskActorId(row.user_id, viewer.viewerId),
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

/** A responder row as a member sees it (D56): exactly 7 keys. */
export interface MemberResponderView {
  /** Full for the resident and the member's own row; masked (D11) for other members. */
  user_id: ReturnType<typeof maskActorId>;
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
