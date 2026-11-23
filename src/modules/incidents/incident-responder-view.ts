import { maskActorId } from './incident-actor-mask';
import type { ResponderRow } from './incident-responders.repository';

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
 * Nothing else of the row (no phone, email or other profile field) exists to leak.
 */
export function responderView(row: ResponderRow, viewer: ResponderViewer) {
  const isMe = !viewer.resident && row.user_id.toLowerCase() === viewer.viewerId.toLowerCase();
  return {
    user_id: viewer.resident ? row.user_id : maskActorId(row.user_id, viewer.viewerId),
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    status: row.status,
    acknowledged_at: row.acknowledged_at,
    status_at: row.status_at,
    is_me: isMe,
  };
}

export type ResponderView = ReturnType<typeof responderView>;
