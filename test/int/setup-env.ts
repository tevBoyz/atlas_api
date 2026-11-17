import { LOCAL_DEFAULT_DATABASE_URL } from '../../src/db/tooling/database-url';

/**
 * Jest setup for integration tests (`npm run test:int`, API-100-07). They run against the LOCAL
 * docker stack (`docker compose up -d --wait`): CI sets the same URLs explicitly. When unset, the
 * local docker URLs are used. `.env` is never read, and remote hosts are refused by the API's own
 * data-store guard (ALLOW_REMOTE_DATA_STORES is removed so it cannot be lifted here).
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= LOCAL_DEFAULT_DATABASE_URL;
process.env.REDIS_URL ||= 'redis://127.0.0.1:63799';
delete process.env.ALLOW_REMOTE_DATA_STORES;
