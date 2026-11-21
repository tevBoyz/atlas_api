import type { Pool } from 'pg';
import type { Logger } from 'pino';

/** What a connection error log carries: never the connection string, host credentials or SQL. */
export interface PgErrorSummary {
  name: string;
  code?: string;
  message: string;
}

export function summarizePgError(err: unknown): PgErrorSummary {
  const error = err as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const summary: PgErrorSummary = {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 200) : String(err),
  };
  if (typeof error?.code === 'string') summary.code = error.code;
  return summary;
}

/**
 * Makes sure no node-postgres connection error on `pool` can ever be unhandled (Phase 7 gap 1).
 *
 * node-postgres emits `'error'` on a Client whose socket dies (server reset, `pg_terminate_backend`,
 * pooler restart). pg-pool listens for that only while the client is IDLE in the pool; while a
 * client is checked out (a query, a transaction, a held connection) it has no listener, and an
 * `'error'` event with no listener throws and kills the process. So:
 *
 * - every client the pool opens gets its own `'error'` listener for its whole life, idle or checked
 *   out (logged once per client at warn, name/code/message only);
 * - the pool's own `'error'` event (an idle client lost) keeps a listener too; the client listener
 *   has already logged it.
 *
 * The broken client is still discarded: pg marks it not queryable, its in-flight query rejects
 * normally (so a request takes the usual error path and its transaction is rolled back by the
 * server), and pg-pool removes a non-queryable client on release instead of reusing it.
 */
export function guardPoolErrors(pool: Pool, logger: Logger, label: string): void {
  pool.on('connect', (client) => {
    let logged = false;
    client.on('error', (err) => {
      // One socket loss can emit twice (the server's FATAL message, then the socket end).
      if (logged) return;
      logged = true;
      logger.warn({ err: summarizePgError(err), pool: label }, 'postgres connection lost');
    });
  });
  pool.on('error', () => {
    // An idle client lost: already logged by its own listener above; the pool drops it.
  });
}
