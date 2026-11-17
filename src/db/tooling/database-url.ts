import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * The local docker database from `docker-compose.yml` (API-100-03). Local-only throwaway
 * credentials, published on 127.0.0.1 only; used when DATABASE_URL is not set anywhere.
 */
export const LOCAL_DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54329/postgres';

export type DatabaseUrlSource = 'environment' | '.env' | 'local default';

export interface ResolvedDatabaseUrl {
  url: string;
  source: DatabaseUrlSource;
}

/**
 * Resolves DATABASE_URL the same way the API does (API-100-02): a real environment variable wins
 * over `.env`. Falls back to the local docker database when neither sets it. An empty value
 * counts as unset. `process.env` is not modified. The caller must still apply the target guard.
 */
export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  envFile = '.env',
): ResolvedDatabaseUrl {
  const fromEnvironment = env.DATABASE_URL?.trim();
  if (fromEnvironment) return { url: fromEnvironment, source: 'environment' };

  if (existsSync(envFile)) {
    const fromFile = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL?.trim();
    if (fromFile) return { url: fromFile, source: '.env' };
  }
  return { url: LOCAL_DEFAULT_DATABASE_URL, source: 'local default' };
}
