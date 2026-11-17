import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_DEFAULT_DATABASE_URL, resolveDatabaseUrl } from './database-url';

describe('resolveDatabaseUrl (API-100-03)', () => {
  let dir: string;
  let envFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-env-'));
    envFile = join(dir, '.env');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prefers the real environment over .env (same rule as the API)', () => {
    writeFileSync(envFile, 'DATABASE_URL=postgresql://u:p@db.example.supabase.co:5432/postgres\n');
    const env = { DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54329/postgres' };
    expect(resolveDatabaseUrl(env, envFile)).toEqual({
      url: env.DATABASE_URL,
      source: 'environment',
    });
  });

  it('reads .env when the environment does not set it, without changing process.env', () => {
    writeFileSync(envFile, 'DATABASE_URL=postgresql://u:p@localhost:5555/x\n');
    const env: NodeJS.ProcessEnv = { DATABASE_URL: '  ' };
    expect(resolveDatabaseUrl(env, envFile)).toEqual({
      url: 'postgresql://u:p@localhost:5555/x',
      source: '.env',
    });
    expect(env.DATABASE_URL).toBe('  ');
  });

  it('falls back to the local docker database', () => {
    writeFileSync(envFile, 'DATABASE_URL=\n');
    expect(resolveDatabaseUrl({}, envFile)).toEqual({
      url: LOCAL_DEFAULT_DATABASE_URL,
      source: 'local default',
    });
    expect(resolveDatabaseUrl({}, join(dir, 'missing.env')).source).toBe('local default');
  });
});
