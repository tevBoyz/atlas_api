/** A UUID in the canonical 8-4-4-4-12 shape (any case). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hex characters kept at each end of a masked UUID (epic §18 D11). */
export const ACTOR_ID_VISIBLE_HEX = 4;

/** What a malformed value becomes: nothing of it is kept. */
export const FULLY_MASKED_UUID = '********-****-****-****-************';

/**
 * Epic §18 D11: the `actor_id` of an incident event as a caller who is not the resident sees it. The
 * first and the last {@link ACTOR_ID_VISIBLE_HEX} hex characters stay, every other hex character
 * becomes `*`, the hyphens and the 36-character shape stay:
 * `4f3a1c2d-9e8b-4a7c-b6d5-1234567f9c2d` → `4f3a****-****-****-****-********9c2d`.
 *
 * - null stays null.
 * - The output is lowercase, as Postgres writes a uuid.
 * - The caller's own id is returned in full (lowercase): the owner can always see their own id.
 * - Anything that is not a UUID is fully masked ({@link FULLY_MASKED_UUID}); never throws.
 */
export function maskActorId(actorId: unknown, callerId: string): string | null {
  if (actorId === null || actorId === undefined) return null;
  if (typeof actorId !== 'string' || !UUID.test(actorId)) return FULLY_MASKED_UUID;
  const normalized = actorId.toLowerCase();
  if (typeof callerId === 'string' && normalized === callerId.toLowerCase()) return normalized;
  const hexCount = 32;
  let seen = 0;
  let masked = '';
  for (const char of normalized) {
    if (char === '-') {
      masked += char;
      continue;
    }
    masked += seen < ACTOR_ID_VISIBLE_HEX || seen >= hexCount - ACTOR_ID_VISIBLE_HEX ? char : '*';
    seen++;
  }
  return masked;
}
