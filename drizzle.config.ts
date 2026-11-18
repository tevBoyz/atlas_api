import { defineConfig } from 'drizzle-kit';

import { resolveDatabaseUrl } from './src/db/tooling/database-url';
import { assertSafeTarget, formatTarget } from './src/db/tooling/target-guard';

/**
 * drizzle-kit is used ONLY to introspect the local baselined database (`npm run db:introspect`).
 * Schema changes are plain SQL in db/migrations/ (`npm run db:migrate`), never drizzle-kit
 * generate/push. The same local-only guard as the db scripts applies.
 *
 * Output goes to .drizzle-introspect/ (git-ignored); src/db/schema.ts is assembled from it.
 */
const { url, source } = resolveDatabaseUrl();
const target = assertSafeTarget(url, false);
process.stderr.write(`Introspecting ${formatTarget(target)} (DATABASE_URL from ${source})\n`);

export const INTROSPECTED_TABLES = [
  'profiles',
  'safety_circles',
  'safety_circle_members',
  'incidents',
  'incident_deliveries',
  'incident_events',
  'app_config',
  'login_lockouts',
  // API-owned (db/migrations/)
  'idempotency_keys',
  'audit_log',
];

export default defineConfig({
  dialect: 'postgresql',
  out: './.drizzle-introspect',
  dbCredentials: { url },
  schemaFilter: ['public'],
  tablesFilter: INTROSPECTED_TABLES,
  introspect: { casing: 'camel' },
});
