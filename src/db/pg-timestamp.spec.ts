import { PgTimestampFormatError, pgTimestampMicros } from './pg-timestamp';

describe('pgTimestampMicros', () => {
  const base = BigInt(Date.UTC(2026, 10, 19, 10, 0, 0)) * 1000n;

  it('reads Postgres UTC text with microseconds', () => {
    expect(pgTimestampMicros('2026-11-19 10:00:00.123456+00')).toBe(base + 123456n);
    expect(pgTimestampMicros('2026-11-19T10:00:00.123456+00:00')).toBe(base + 123456n);
    expect(pgTimestampMicros('2026-11-19 10:00:00+00')).toBe(base);
    expect(pgTimestampMicros('2026-11-19T10:00:00.5Z')).toBe(base + 500000n);
  });

  it('keeps instants one microsecond apart distinct (a Date would not)', () => {
    expect(pgTimestampMicros('2026-11-19 10:00:00.000001+00')).toBeGreaterThan(
      pgTimestampMicros('2026-11-19 10:00:00+00'),
    );
  });

  it('applies offsets with minutes and seconds', () => {
    expect(pgTimestampMicros('2026-11-19 15:30:00+05:30')).toBe(base);
    expect(pgTimestampMicros('2026-11-19 07:00:00-03')).toBe(base);
    expect(pgTimestampMicros('2026-11-19 09:59:30-00:00:30')).toBe(base);
  });

  it('reads infinity, -infinity and a Date', () => {
    expect(pgTimestampMicros('infinity')).toBeGreaterThan(base * 1000n);
    expect(pgTimestampMicros('-infinity')).toBeLessThan(-base * 1000n);
    expect(pgTimestampMicros(new Date(Date.UTC(2026, 10, 19, 10)))).toBe(base);
  });

  it('keeps years below 100 as written', () => {
    expect(pgTimestampMicros('0050-01-01 00:00:00+00')).toBeLessThan(
      pgTimestampMicros('1950-01-01 00:00:00+00'),
    );
  });

  it('refuses anything else', () => {
    expect(() => pgTimestampMicros('yesterday')).toThrow(PgTimestampFormatError);
    expect(() => pgTimestampMicros(new Date(Number.NaN))).toThrow(PgTimestampFormatError);
  });
});
