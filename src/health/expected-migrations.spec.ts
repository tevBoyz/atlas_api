import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadExpectedMigrations,
  MIGRATIONS_DIR,
  MIGRATIONS_MANIFEST_FILE,
} from './expected-migrations';

describe('expected migrations (API-100-07)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-migrations-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves to dist/migrations-manifest.json and the project db/migrations', () => {
    expect(MIGRATIONS_MANIFEST_FILE.replace(/\\/g, '/')).toMatch(
      /\/src\/migrations-manifest\.json$/,
    );
    expect(MIGRATIONS_DIR.replace(/\\/g, '/')).toMatch(/\/db\/migrations$/);
    expect(MIGRATIONS_DIR.replace(/\\/g, '/')).not.toMatch(/\/src\/db\/migrations$/);
  });

  it('reads the build-time manifest when present (built app / Docker image)', () => {
    const manifest = join(dir, 'migrations-manifest.json');
    writeFileSync(manifest, JSON.stringify({ migrations: ['0001_audit_log'] }));
    expect(loadExpectedMigrations(manifest, join(dir, 'missing'))).toEqual({
      ids: ['0001_audit_log'],
    });
  });

  it('falls back to the db/migrations directory (running from source)', () => {
    const migrations = join(dir, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '0002_b.sql'), '');
    writeFileSync(join(migrations, '0001_a.sql'), '');
    writeFileSync(join(migrations, 'README.md'), '');
    expect(loadExpectedMigrations(join(dir, 'none.json'), migrations)).toEqual({
      ids: ['0001_a', '0002_b'],
    });
  });

  it('an empty migrations directory expects nothing', () => {
    const migrations = join(dir, 'migrations');
    mkdirSync(migrations);
    expect(loadExpectedMigrations(join(dir, 'none.json'), migrations)).toEqual({ ids: [] });
  });

  it('reports an error (readiness fails) when neither exists or the manifest is bad', () => {
    expect(loadExpectedMigrations(join(dir, 'none.json'), join(dir, 'none'))).toHaveProperty(
      'error',
    );
    const manifest = join(dir, 'migrations-manifest.json');
    writeFileSync(manifest, JSON.stringify({ migrations: [1] }));
    expect(loadExpectedMigrations(manifest, join(dir, 'none'))).toHaveProperty('error');
  });
});
