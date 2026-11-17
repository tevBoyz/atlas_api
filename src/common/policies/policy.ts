import { isSQLWrapper, type SQL, sql, type SQLWrapper } from 'drizzle-orm';

/**
 * Policy building blocks (API-100-09).
 *
 * Every policy is ONE SQL predicate, so the list form and the single-row form cannot drift apart:
 * - `where(args)` returns a Drizzle `SQL` boolean for a WHERE clause; pass columns (e.g.
 *   `incidents.circleId`) to filter a list;
 * - `check(db, args)` evaluates the same predicate for concrete values in one round trip.
 *
 * Operands are either SQL (a column or expression) or plain values. Values are sent as typed
 * parameters (`$n::uuid`, `$n::timestamptz`). Timestamps compare in the database at microsecond
 * precision: pass the database's own text (Drizzle `mode: 'string'` columns), not a JS `Date`
 * (milliseconds only), when the exact instant matters (rule 54 window boundary).
 */

/** A uuid column/expression, or a uuid value. `null`/`undefined` → SQL NULL. */
export type UuidOperand = SQLWrapper | string | null | undefined;
/** A timestamptz column/expression, or a value (database text preferred, see above). */
export type TimestampOperand = SQLWrapper | string | Date | null | undefined;
/** A text column/expression, or a text value. */
export type TextOperand = SQLWrapper | string | null | undefined;

export function uuidSql(value: UuidOperand): SQL {
  return isSQLWrapper(value) ? sql`${value}` : sql`(${value ?? null})::uuid`;
}

export function timestampSql(value: TimestampOperand): SQL {
  if (isSQLWrapper(value)) return sql`${value}`;
  const text = value instanceof Date ? value.toISOString() : (value ?? null);
  return sql`(${text})::timestamptz`;
}

export function textSql(value: TextOperand): SQL {
  return isSQLWrapper(value) ? sql`${value}` : sql`(${value ?? null})::text`;
}

/** Anything with Drizzle's `execute` (the database, or a transaction `tx`). */
export interface SqlExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Evaluates a boolean predicate; SQL NULL counts as false. */
export async function evaluate(db: SqlExecutor, predicate: SQL): Promise<boolean> {
  const result = await db.execute(sql`select coalesce((${predicate}), false) as allowed`);
  return result.rows[0]?.allowed === true;
}

/** The policy names of spec §11.4 (API-100-09 AC1). */
export type PolicyName =
  | 'profile.self'
  | 'circle.owner'
  | 'circle.activeMember'
  | 'circle.activeMemberSince'
  | 'incident.resident'
  | 'incident.memberView'
  | 'incident.eventsView'
  | 'incident.countsView'
  | 'delivery.own'
  | 'invite.recipient'
  | 'membership.activate';

export interface Policy<A> {
  readonly name: PolicyName;
  /** The rule as a SQL boolean (lists, joins, UPDATE/DELETE guards). */
  where(args: A): SQL;
  /** The same rule for one set of values. */
  check(db: SqlExecutor, args: A): Promise<boolean>;
}

export function definePolicy<A>(name: PolicyName, where: (args: A) => SQL): Policy<A> {
  return {
    name,
    where,
    check: (db, args) => evaluate(db, where(args)),
  };
}

/** A column of a table alias inside a policy subquery (constant identifiers only). */
export function aliasColumn(alias: string, column: string): SQL {
  return sql.raw(`${alias}.${column}`);
}
