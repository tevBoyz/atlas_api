import { randomUUID } from 'node:crypto';

/**
 * A new invite token, in the format of `new_circle_invite_token()` (baseline 20261019120000):
 * `replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`, i.e. two random (v4) UUIDs
 * without hyphens, 64 lowercase hex characters. `randomUUID` draws from Node's CSPRNG, as
 * `gen_random_uuid` draws from the server's. Uniqueness is left to the unique index
 * `safety_circle_members_invite_token_uidx`, as the SQL does (no pre-check, no retry).
 */
export function newInviteToken(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
}

/** The shape of every token this API and the SQL create. */
export const INVITE_TOKEN_FORMAT = /^[0-9a-f]{64}$/;
