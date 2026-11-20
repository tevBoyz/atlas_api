/**
 * Readiness checks (API-100-07 AC2), framework-free so they are easy to test.
 * Each check gets a short timeout so `/readyz` never hangs; checks run in parallel; `failed` lists
 * failing checks in the fixed order db, redis, migrations, realtime, jobs.
 */

/**
 * `realtime` = the Socket.IO Redis adapter's publisher and subscriber (API-100-39 AC5); `jobs` = the
 * BullMQ producers' Redis connection (API-100-45 AC5).
 */
export const READINESS_CHECKS = ['db', 'redis', 'migrations', 'realtime', 'jobs'] as const;
export type ReadinessCheckName = (typeof READINESS_CHECKS)[number];

/** Per-check time budget. A check still running after this counts as failed. */
export const READINESS_CHECK_TIMEOUT_MS = 1_500;

/** A check resolves when healthy and rejects (or times out) when not. */
export type ReadinessCheck = () => Promise<void>;

export interface ReadinessReport {
  ready: boolean;
  /** Failing checks, in {@link READINESS_CHECKS} order. */
  failed: ReadinessCheckName[];
  /** Why each failing check failed (for logs only, never in the response). */
  reasons: Partial<Record<ReadinessCheckName, string>>;
}

/** 200 body. */
export interface ReadyBody {
  status: 'ok';
}

/** 503 body: deliberately NOT the error envelope (documented exemption, see README). */
export interface UnavailableBody {
  status: 'unavailable';
  failed: ReadinessCheckName[];
}

export class ReadinessTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = 'ReadinessTimeoutError';
  }
}

/** Runs `check` with a time limit. The timer never keeps the process alive. */
export async function withTimeout(check: ReadinessCheck, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadinessTimeoutError(ms)), ms);
    timer.unref();
  });
  try {
    // A synchronous throw inside `check` becomes a rejection too.
    await Promise.race([Promise.resolve().then(check), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runReadinessChecks(
  checks: Record<ReadinessCheckName, ReadinessCheck>,
  timeoutMs = READINESS_CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const outcomes = await Promise.allSettled(
    READINESS_CHECKS.map((name) => withTimeout(checks[name], timeoutMs)),
  );
  const failed: ReadinessCheckName[] = [];
  const reasons: ReadinessReport['reasons'] = {};
  outcomes.forEach((outcome, index) => {
    const name = READINESS_CHECKS[index];
    if (name === undefined || outcome.status === 'fulfilled') return;
    failed.push(name);
    reasons[name] = reasonOf(outcome.reason);
  });
  return { ready: failed.length === 0, failed, reasons };
}

/**
 * The migrations check: every expected id must be recorded in `public.api_schema_migrations`.
 * Nothing expected → passes without touching the database (the table may not even exist yet).
 * `fetchApplied` returns which of the given ids are recorded.
 */
export async function checkMigrationsApplied(
  expected: readonly string[],
  fetchApplied: (ids: readonly string[]) => Promise<string[]>,
): Promise<void> {
  if (expected.length === 0) return;
  const applied = new Set(await fetchApplied(expected));
  const missing = expected.filter((id) => !applied.has(id));
  if (missing.length > 0) {
    throw new Error(`${missing.length} migration(s) not applied: ${missing.join(', ')}`);
  }
}
