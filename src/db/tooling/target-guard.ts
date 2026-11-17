/**
 * Production-safety guard for every `db:*` script (API-100-03).
 *
 * The scripts only ever run against a local database unless the caller passes `--allow-remote`
 * explicitly. Output names the target by host, port and database only, never user or password.
 */

/** Hosts the scripts accept without `--allow-remote`. */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/** The flag that lifts the local-only rule. Reserved for an approved deploy step. */
export const ALLOW_REMOTE_FLAG = '--allow-remote';

/** Credential-free description of a database target, safe to print. */
export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
  isLocal: boolean;
}

/** Thrown when a target is refused. Its message never contains credentials. */
export class UnsafeDatabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDatabaseTargetError';
  }
}

/** Connection-string query parameters that can silently redirect libpq/node-postgres elsewhere. */
const HOST_OVERRIDE_PARAMS = ['host', 'hostaddr', 'port', 'service'];

/**
 * Parses a postgres URL into a printable target. Rejects anything that is not a plain
 * `postgres://` / `postgresql://` URL with an explicit host (no socket/env/query-param fallbacks),
 * so what is checked is exactly what node-postgres will connect to.
 */
export function describeTarget(databaseUrl: string): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UnsafeDatabaseTargetError('DATABASE_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new UnsafeDatabaseTargetError('DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (host.length === 0) {
    throw new UnsafeDatabaseTargetError('DATABASE_URL must name a host explicitly.');
  }
  for (const param of HOST_OVERRIDE_PARAMS) {
    if (url.searchParams.has(param)) {
      throw new UnsafeDatabaseTargetError(
        `DATABASE_URL must not set the "${param}" query parameter (it can redirect the connection).`,
      );
    }
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return {
    host,
    port: url.port === '' ? 5432 : Number(url.port),
    database: database === '' ? '(default)' : database,
    isLocal: LOCAL_HOSTS.includes(host),
  };
}

/** `host:port/database`, never credentials. */
export function formatTarget(target: DatabaseTarget): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `${host}:${target.port}/${target.database}`;
}

/**
 * Returns the target if it is local, or remote with `allowRemote`. Otherwise throws
 * {@link UnsafeDatabaseTargetError} naming only host/port/database.
 */
export function assertSafeTarget(databaseUrl: string, allowRemote: boolean): DatabaseTarget {
  const target = describeTarget(databaseUrl);
  if (!target.isLocal && !allowRemote) {
    throw new UnsafeDatabaseTargetError(
      `Refusing to run against ${formatTarget(target)}: db scripts only run against ` +
        `${LOCAL_HOSTS.join(', ')}. Set DATABASE_URL to the local docker database ` +
        `(see .env.example). ${ALLOW_REMOTE_FLAG} exists only for an approved deploy step.`,
    );
  }
  return target;
}
