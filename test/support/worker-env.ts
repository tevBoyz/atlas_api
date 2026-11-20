import { useTestJwtEnvironment } from '../../src/testing/test-auth-config';
import { workerDatabaseUrl, workerRedisUrl } from './stack';

/**
 * Jest setupFiles for the container-backed suites (API-100-13). Runs in every worker before any
 * test code: points the API at THIS worker's database and Redis index and removes anything the
 * shell could have set. `.env` is never read and the compose stack is never used. Access tokens are
 * verified with the local test secret (`src/testing/test-auth-config.ts`). Avatar Storage is the
 * in-memory fake (no Storage key, no network).
 */
const INHERITED_SETTINGS =
  /^(RATE_LIMIT_|OPENAPI_|TRUST_PROXY$|ALLOW_REMOTE_DATA_STORES$|SUPABASE_STORAGE_SERVICE_KEY$|AVATAR_STORAGE$)/;

for (const key of Object.keys(process.env)) {
  if (INHERITED_SETTINGS.test(key)) delete process.env[key];
}
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = workerDatabaseUrl();
process.env.REDIS_URL = workerRedisUrl();
// Profile photos go to the in-memory fake: tests never call Supabase Storage (API-100-37).
process.env.AVATAR_STORAGE = 'memory';
useTestJwtEnvironment();
