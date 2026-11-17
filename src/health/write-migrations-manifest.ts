import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { listMigrationFiles } from '../db/tooling/migrate';
import { MIGRATIONS_MANIFEST_FILE, type MigrationsManifest } from './expected-migrations';

/**
 * Build step (`postbuild`, API-100-07): records the API migration ids from `db/migrations/` in
 * `dist/migrations-manifest.json`, which the readiness check of the built app reads. Run from the
 * project root (npm does). Fails the build when `db/migrations/` is missing (e.g. a Docker build
 * that forgot to copy it), since an empty list would silently skip the check.
 */
function main(): void {
  const dir = join(process.cwd(), 'db', 'migrations');
  if (!existsSync(dir)) {
    process.stderr.write(`migrations-manifest: ${dir} not found\n`);
    process.exit(1);
  }
  const manifest: MigrationsManifest = { migrations: listMigrationFiles(dir).map((f) => f.id) };
  writeFileSync(MIGRATIONS_MANIFEST_FILE, `${JSON.stringify(manifest)}\n`);
  process.stdout.write(
    `migrations-manifest: ${manifest.migrations.length} migration(s) recorded\n`,
  );
}

main();
