import { useTestJwtEnvironment } from '../../src/testing/test-auth-config';
import { useTestAuthEnvironment } from '../../src/testing/test-auth-keys';
import { workerDatabaseUrl, workerId, workerRedisUrl } from './stack';

/**
 * Jest setupFiles for the container-backed suites (API-100-13). Runs in every worker before any
 * test code: points the API at THIS worker's database and Redis index and removes anything the
 * shell could have set. `.env` is never read and the compose stack is never used. Access tokens are
 * verified with the local test secret (`src/testing/test-auth-config.ts`). Avatar Storage is the
 * in-memory fake (no Storage key, no network). Notification channels keep their defaults (all off,
 * fake adapters): no test can reach a real push, SMS or email provider.
 */
const INHERITED_SETTINGS =
  /^(RATE_LIMIT_|REALTIME_|OPENAPI_|TRUST_PROXY$|ALLOW_REMOTE_DATA_STORES$|SUPABASE_STORAGE_SERVICE_KEY$|AVATAR_STORAGE$|WORKER$|JOBS_|OUTBOX_|NOTIFICATIONS_|CHANNEL_|FCM_|APNS_|TWILIO_)/;

for (const key of Object.keys(process.env)) {
  if (INHERITED_SETTINGS.test(key)) delete process.env[key];
}
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = workerDatabaseUrl();
process.env.REDIS_URL = workerRedisUrl();
// Redis pub/sub ignores the database index: each worker gets its own Socket.IO adapter channels, so
// parallel suites never see each other's broadcasts (API-100-39).
process.env.REALTIME_ADAPTER_KEY = `atlas:realtime:test:w${workerId()}`;
// Profile photos go to the in-memory fake: tests never call Supabase Storage (API-100-37).
process.env.AVATAR_STORAGE = 'memory';
useTestJwtEnvironment();
// Own access tokens (API-100-51): fresh throwaway keys per worker; never Google or Apple (their
// settings are removed, so both providers are disabled unless a suite configures a fake JWKS).
useTestAuthEnvironment();
// Supabase access tokens are off by default since stage 7.1d (D40). The suites still sign their
// callers with Supabase-style test tokens (the parity tests call the SQL functions as today's app
// did), so they turn them on explicitly; `test/int/supabase-tokens-default.int-spec.ts` checks the
// default.
process.env.SUPABASE_JWT_ACCEPT = 'true';
