/**
 * Postgres `timestamptz` text → microseconds since the Unix epoch, as a `bigint`, so comparisons keep
 * the database's microsecond precision (a JS `Date` keeps milliseconds only, and two instants in the
 * same millisecond would compare equal). Accepts what Postgres writes for `timestamptz` (Drizzle
 * `mode: 'string'` columns, `::text`, JSON): `2026-11-19 10:00:00.123456+00`,
 * `2026-11-19T10:00:00.5+05:30`, `...-03:00:00`, `infinity`, `-infinity`; and a `Date`.
 */

export type PgTimestamp = string | Date;

/** Larger / smaller than every finite instant (Postgres `infinity` / `-infinity`). */
const POSITIVE_INFINITY = 2n ** 62n;
const NEGATIVE_INFINITY = -(2n ** 62n);

const TIMESTAMP_TEXT =
  /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)$/;

export class PgTimestampFormatError extends Error {
  constructor() {
    super('Not a Postgres timestamptz text value');
    this.name = 'PgTimestampFormatError';
  }
}

export function pgTimestampMicros(value: PgTimestamp): bigint {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new PgTimestampFormatError();
    return BigInt(ms) * 1000n;
  }
  const text = value.trim();
  if (text === 'infinity') return POSITIVE_INFINITY;
  if (text === '-infinity') return NEGATIVE_INFINITY;
  const match = TIMESTAMP_TEXT.exec(text);
  if (!match) throw new PgTimestampFormatError();
  const [, year, month, day, hour, minute, second, fraction, zulu, sign, offH, offM, offS] = match;
  const date = new Date(0);
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  const epochMs = date.getTime();
  if (Number.isNaN(epochMs)) throw new PgTimestampFormatError();
  const micros = BigInt(epochMs) * 1000n + BigInt((fraction ?? '').padEnd(6, '0') || '0');
  if (zulu || !sign) return micros;
  const offsetSeconds = Number(offH) * 3600 + Number(offM ?? 0) * 60 + Number(offS ?? 0);
  const offsetMicros = BigInt(offsetSeconds) * 1_000_000n;
  // Local time = UTC + offset, so UTC = local - offset.
  return sign === '+' ? micros - offsetMicros : micros + offsetMicros;
}
