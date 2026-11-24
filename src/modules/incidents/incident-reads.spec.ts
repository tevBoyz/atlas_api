import {
  clampRecentIncidentsLimit,
  openIncidentResultSchema,
  recentIncidentSchema,
  recentIncidentsQuerySchema,
} from './incident.schemas';

/** API-100-16: `list_my_recent_incidents` limit rules and the read response shapes. */
describe('recent incidents limit (API-100-16 AC2)', () => {
  it.each([
    [undefined, 5],
    [1, 1],
    [5, 5],
    [20, 20],
    [21, 20],
    [500, 20],
    [0, 1],
    [-3, 1],
    [-2_147_483_648, 1],
    [2_147_483_647, 20],
  ])('least(greatest(coalesce(%p, 5), 1), 20) = %p', (limit, expected) => {
    expect(clampRecentIncidentsLimit(limit)).toBe(expected);
  });

  const parse = (query: Record<string, unknown>) => recentIncidentsQuerySchema.safeParse(query);

  it.each([
    ['5', 5],
    ['0', 0],
    ['-3', -3],
    ['+7', 7],
    ['007', 7],
    ['2147483647', 2_147_483_647],
    ['-2147483648', -2_147_483_648],
  ])('accepts the integer %p', (value, expected) => {
    expect(parse({ limit: value })).toEqual({ success: true, data: { limit: expected } });
  });

  it('a missing limit stays undefined (→ 5)', () => {
    expect(parse({})).toEqual({ success: true, data: {} });
  });

  it.each([
    ['letters', 'abc'],
    ['a decimal', '2.5'],
    ['an exponent', '1e1'],
    ['empty', ''],
    ['spaces', ' 5'],
    ['hex', '0x10'],
    ['the word null', 'null'],
    ['above int4', '2147483648'],
    ['below int4', '-2147483649'],
    ['repeated', ['1', '2']],
  ])('refuses %s, naming the field', (_label, value) => {
    const result = parse({ limit: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['limit']);
  });
});

describe('read response schemas (API-100-16 AC1, AC2)', () => {
  it('the open wrapper accepts null', () => {
    expect(openIncidentResultSchema.parse({ open_incident: null })).toEqual({
      open_incident: null,
    });
  });

  it('a recent entry has exactly 9 keys (the SQL 7 plus auto_closed, closed_at: SCRUM-63)', () => {
    expect(Object.keys(recentIncidentSchema.shape).sort()).toEqual([
      'activated_at',
      'auto_closed',
      'closed_at',
      'emergency_type',
      'id',
      'resolved_at',
      'resolved_reason',
      'sent_at',
      'status',
    ]);
  });
});
