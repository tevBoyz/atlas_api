import { generatePrivateJwk } from '../config/jwt-keys';

/**
 * Throwaway signing keys for the API's own access tokens (API-100-51), generated at runtime for
 * tests, the load checks and the manual guide. Key material is never written to the repository.
 */
export interface ThrowawayAuthKeys {
  AUTH_JWT_KEYS: string;
  AUTH_JWT_ACTIVE_KID: string;
}

/** One private JWK (Ed25519 by default, or P-256) with `kid`. */
export function throwawayJwk(
  kid: string,
  type: 'ed25519' | 'p256' = 'ed25519',
): Record<string, string> {
  return generatePrivateJwk(kid, type);
}

/** AUTH_JWT_KEYS / AUTH_JWT_ACTIVE_KID with fresh keys; the first kid is the active one. */
export function throwawayAuthKeys(kids: readonly string[] = ['test-key-1']): ThrowawayAuthKeys {
  return {
    AUTH_JWT_KEYS: JSON.stringify(kids.map((kid) => throwawayJwk(kid))),
    AUTH_JWT_ACTIVE_KID: kids[0],
  };
}

/** Removes inherited own-auth and provider settings, then sets fresh throwaway keys. */
export function useTestAuthEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (/^(AUTH_|GOOGLE_|APPLE_|SUPABASE_JWT_)/.test(key)) delete env[key];
  }
  Object.assign(env, throwawayAuthKeys());
}
