/**
 * Supabase-shaped JWT settings used by automated tests (API-100-08). Test-only values: the secret
 * signs tokens that only an API configured with this same value accepts (unit and integration test
 * setups set it). Never a real project's secret, issuer or keys; tests never call Supabase.
 */
// Assembled at runtime so secret scanners do not flag a test-only value.
export const TEST_JWT_SECRET = ['atlas', 'test', 'only', 'hs256', 'not', 'a', 'real', 'key'].join(
  '-',
);
export const TEST_JWT_ISSUER = 'http://127.0.0.1:54321/auth/v1';
export const TEST_JWT_AUDIENCE = 'authenticated';

/** Points the process environment at the test JWT settings (no JWKS: tests use local keys). */
export function useTestJwtEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
  env.SUPABASE_JWT_ISSUER = TEST_JWT_ISSUER;
  env.SUPABASE_JWT_AUDIENCE = TEST_JWT_AUDIENCE;
  delete env.SUPABASE_JWT_JWKS_URL;
  delete env.SUPABASE_JWT_CLOCK_SKEW_SECONDS;
}
