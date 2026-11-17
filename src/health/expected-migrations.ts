import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listMigrationFiles } from '../db/tooling/migrate';

/**
 * Which API migrations this build expects to be applied (readiness "migrations" check, API-100-07).
 *
 * - Built app (`dist/`, local or Docker image): `dist/migrations-manifest.json`, written by
 *   `npm run build` (postbuild, `write-migrations-manifest.ts`) from `db/migrations/`. The image
 *   does not ship `db/`, so the list is fixed at build time: it is exactly what this build expects.
 * - From source (ts-jest, tsx): read `db/migrations/` directly.
 */

/** Written next to `main.js` by `npm run build`. */
export const MIGRATIONS_MANIFEST_FILE = join(__dirname, '..', 'migrations-manifest.json');
/** `db/migrations/` of the project (same relative position from `src/health` and `dist/health`). */
export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

export interface MigrationsManifest {
  migrations: string[];
}

/** Either the expected ids, or why they could not be determined (readiness then fails). */
export type ExpectedMigrations = { ids: string[] } | { error: string };

/** DI token for {@link ExpectedMigrations}. */
export const EXPECTED_MIGRATIONS = Symbol('EXPECTED_MIGRATIONS');

function parseManifest(text: string): string[] {
  const parsed = JSON.parse(text) as Partial<MigrationsManifest>;
  const ids = parsed.migrations;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new Error('migrations must be a list of ids');
  }
  return ids;
}

export function loadExpectedMigrations(
  manifestFile = MIGRATIONS_MANIFEST_FILE,
  migrationsDir = MIGRATIONS_DIR,
): ExpectedMigrations {
  try {
    if (existsSync(manifestFile)) return { ids: parseManifest(readFileSync(manifestFile, 'utf8')) };
    if (existsSync(migrationsDir))
      return { ids: listMigrationFiles(migrationsDir).map((f) => f.id) };
    return { error: 'no migrations manifest and no db/migrations directory' };
  } catch (error) {
    return { error: `migration list unreadable: ${(error as Error).message}` };
  }
}
