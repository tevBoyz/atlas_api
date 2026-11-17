/**
 * Extracts the access token from an `Authorization` header (API-100-08 AC1, AC6 "malformed
 * header"). Accepts exactly `Bearer <token>` (scheme case-insensitive, one header) where the token
 * has the JWS compact shape `header.payload.signature` (base64url parts). Anything else is
 * `undefined` (→ 401). The token itself is never logged (the log scrubber redacts the header too).
 */

/** Longest token accepted before any parsing (Supabase access tokens are ~1 KB). */
export const MAX_TOKEN_LENGTH = 8_192;

const BEARER = /^Bearer +([^ ]+) *$/i;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 16) return undefined;
  const match = BEARER.exec(header);
  const token = match?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH || !COMPACT_JWS.test(token)) return undefined;
  return token;
}
