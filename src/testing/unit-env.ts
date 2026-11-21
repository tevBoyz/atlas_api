import { useTestJwtEnvironment } from './test-auth-config';
import { useTestAuthEnvironment } from './test-auth-keys';

/**
 * Jest setup for unit tests (`npm test`, API-100-07). Unit tests never need Docker: the API's data
 * store URLs are removed so the app under test does not try to connect to Postgres or Redis even
 * when the shell (or CI) sets them. Tests that need a data store provide a fake.
 * Access tokens are verified with the local test secret only (API-100-08): never a real JWKS.
 */
for (const key of [
  'DATABASE_URL',
  'REDIS_URL',
  'ALLOW_REMOTE_DATA_STORES',
  'SUPABASE_STORAGE_SERVICE_KEY',
]) {
  delete process.env[key];
}
// Jobs and channels (Phase 5): never inherited from the shell, so every test starts from the
// defaults (channels off, fake adapters, no worker mode).
for (const key of Object.keys(process.env)) {
  if (/^(WORKER$|JOBS_|OUTBOX_|NOTIFICATIONS_|CHANNEL_|FCM_|APNS_|TWILIO_)/.test(key)) {
    delete process.env[key];
  }
}
// Profile photos: the in-memory fake (unit tests never call Supabase Storage).
process.env.AVATAR_STORAGE = 'memory';
useTestJwtEnvironment();
// Own access tokens (API-100-51): fresh throwaway keys; no Google/Apple settings are inherited.
useTestAuthEnvironment();
// Supabase access tokens are off by default since stage 7.1d (D40); unit tests sign callers with
// Supabase-style test tokens, so they turn them on explicitly.
process.env.SUPABASE_JWT_ACCEPT = 'true';
