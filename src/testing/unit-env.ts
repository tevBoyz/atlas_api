import { useTestJwtEnvironment } from './test-auth-config';

/**
 * Jest setup for unit tests (`npm test`, API-100-07). Unit tests never need Docker: the API's data
 * store URLs are removed so the app under test does not try to connect to Postgres or Redis even
 * when the shell (or CI) sets them. Tests that need a data store provide a fake.
 * Access tokens are verified with the local test secret only (API-100-08): never a real JWKS.
 */
for (const key of ['DATABASE_URL', 'REDIS_URL', 'ALLOW_REMOTE_DATA_STORES']) {
  delete process.env[key];
}
useTestJwtEnvironment();
