import { DomainError, type ErrorPrefix } from '../../common/errors';
import type { DatabaseService } from '../../db/database.service';
import type { AuditTransaction } from '../audit';
import type { IncidentTransaction } from './incidents.repository';

/** The open transaction of an incident write: SQL statements and the audit row. */
export type IncidentWriteTransaction = IncidentTransaction & AuditTransaction;

/**
 * An incident operation that failed in the database. It replaces the original error because that one
 * can carry the query parameters (emergency type, coordinates, a note) and row values (share fields),
 * and errors are logged and reported. Only the operation and the SQLSTATE are kept.
 */
export class IncidentOperationFailedError extends Error {
  constructor(
    readonly operation: ErrorPrefix,
    readonly sqlState: string | undefined,
  ) {
    super(`${operation} failed in the database`);
    this.name = 'IncidentOperationFailedError';
  }
}

/** {@link IncidentOperationFailedError} of `submit_emergency_alert` (API-100-15). */
export class IncidentSubmitFailedError extends IncidentOperationFailedError {
  constructor(sqlState: string | undefined) {
    super('submit_emergency_alert', sqlState);
    this.name = 'IncidentSubmitFailedError';
  }
}

function sqlStateOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
}

/**
 * Runs `work` in one transaction. A {@link DomainError} passes through (the transaction is rolled
 * back); any other error is replaced by `failed(sqlState)`, so no parameter or row value can reach a
 * log or an error report.
 */
export async function runIncidentTransaction<T>(
  database: DatabaseService,
  work: (tx: IncidentWriteTransaction) => Promise<T>,
  failed: (sqlState: string | undefined) => Error,
): Promise<T> {
  try {
    return await database.db.transaction((tx) => work(tx));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw failed(sqlStateOf(error));
  }
}
