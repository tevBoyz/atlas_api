import { describeTarget, LOCAL_HOSTS, UnsafeDatabaseTargetError } from '../db/tooling/target-guard';

/**
 * Production-safety guard for the API itself (API-100-07). Outside `NODE_ENV=production` the API
 * refuses to start when DATABASE_URL or REDIS_URL points anywhere but this machine, unless
 * `ALLOW_REMOTE_DATA_STORES=true`. Same local-host rule as the `db:*` scripts
 * (`db/tooling/target-guard.ts`). Messages name the key and the host only, never credentials.
 */

/** Keys the guard checks. */
export const DATA_STORE_KEYS = ['DATABASE_URL', 'REDIS_URL'] as const;
export type DataStoreKey = (typeof DATA_STORE_KEYS)[number];

export interface DataStoreProblem {
  key: DataStoreKey;
  /** Why it is refused. Contains the host at most, never user, password or the full URL. */
  reason: string;
}

const LOCAL_LIST = LOCAL_HOSTS.join(', ');

function remoteReason(host: string): string {
  return (
    `points to the non-local host "${host}"; outside NODE_ENV=production the API only connects to ` +
    `${LOCAL_LIST}. Use the local docker URL from .env.example, or set ` +
    `ALLOW_REMOTE_DATA_STORES=true only on Dawit's explicit instruction`
  );
}

/** The host of a URL (brackets removed, lower case), or undefined when it cannot be parsed. */
function hostOf(value: string): string | undefined {
  try {
    return new URL(value).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  } catch {
    return undefined;
  }
}

function databaseProblem(url: string): DataStoreProblem | undefined {
  try {
    const target = describeTarget(url);
    return target.isLocal ? undefined : { key: 'DATABASE_URL', reason: remoteReason(target.host) };
  } catch (error) {
    if (error instanceof UnsafeDatabaseTargetError) {
      // Unparseable URLs are reported by the schema rule; this covers host-redirecting parameters.
      return {
        key: 'DATABASE_URL',
        reason: 'must name a local host explicitly (no host/hostaddr/port/service parameters)',
      };
    }
    throw error;
  }
}

function redisProblem(url: string): DataStoreProblem | undefined {
  const host = hostOf(url);
  if (host === undefined) return undefined; // reported by the schema rule
  if (host.length === 0) return { key: 'REDIS_URL', reason: 'must name a local host explicitly' };
  return LOCAL_HOSTS.includes(host) ? undefined : { key: 'REDIS_URL', reason: remoteReason(host) };
}

export interface DataStoreSettings {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  REDIS_URL?: string;
  ALLOW_REMOTE_DATA_STORES?: boolean;
}

/** Problems that must stop the API from starting (empty when the targets are acceptable). */
export function dataStoreProblems(settings: DataStoreSettings): DataStoreProblem[] {
  if (settings.NODE_ENV === 'production' || settings.ALLOW_REMOTE_DATA_STORES === true) return [];
  const problems: DataStoreProblem[] = [];
  if (settings.DATABASE_URL) {
    const problem = databaseProblem(settings.DATABASE_URL);
    if (problem) problems.push(problem);
  }
  if (settings.REDIS_URL) {
    const problem = redisProblem(settings.REDIS_URL);
    if (problem) problems.push(problem);
  }
  return problems;
}
