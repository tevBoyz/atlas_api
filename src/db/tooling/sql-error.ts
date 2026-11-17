/** Error shape node-postgres raises for server errors (only the fields we print). */
export interface PgServerError {
  message: string;
  code?: string;
  position?: string;
  where?: string;
}

export function isPgServerError(error: unknown): error is PgServerError {
  return error instanceof Error && 'code' in error;
}

/** 1-based line number of a 1-based character `position` inside `sql`. */
export function lineOfPosition(sql: string, position: number): number {
  return sql.slice(0, Math.max(0, position - 1)).split('\n').length;
}

/** `message (SQLSTATE x) at line n` — no connection details, no values beyond the server message. */
export function describeSqlError(error: unknown, sql?: string): string {
  if (!isPgServerError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const parts = [error.message];
  if (error.code) parts.push(`(SQLSTATE ${error.code})`);
  if (sql !== undefined && error.position) {
    parts.push(`at line ${lineOfPosition(sql, Number(error.position))}`);
  }
  if (error.where) parts.push(`\n    where: ${error.where.split('\n')[0]}`);
  return parts.join(' ');
}
