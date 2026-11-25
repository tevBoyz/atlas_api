import {
  ACTIVITY_MAX_LIMIT,
  activityQuerySchema,
  decodeActivityCursor,
  encodeActivityCursor,
} from './activity.schemas';

const ID = '0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b';
const AT = '2026-11-25T09:41:07.123456Z';
const raw = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

/** The `details.field` of the first issue, as the validation pipe names it, or 'ok'. */
function field(query: Record<string, unknown>): string {
  const result = activityQuerySchema.safeParse(query);
  return result.success ? 'ok' : String(result.error.issues[0].path[0]);
}

describe('activity cursor (SCRUM-82, D72)', () => {
  it('round-trips occurred_at (microseconds) and the event id', () => {
    const cursor = encodeActivityCursor({ occurredAt: AT, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActivityCursor(cursor)).toEqual({ occurredAt: AT, id: ID });
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['one part', raw(AT)],
    ['three parts', raw(`${AT}|${ID}|x`)],
    ['no microseconds', raw(`2026-11-25T09:41:07.123Z|${ID}`)],
    ['an offset instead of Z', raw(`2026-11-25T09:41:07.123456+00:00|${ID}`)],
    ['day 31 of a 30-day month', raw(`2026-11-31T09:41:07.123456Z|${ID}`)],
    ['hour 24', raw(`2026-11-25T24:00:00.000000Z|${ID}`)],
    ['an uppercase id', raw(`${AT}|${ID.toUpperCase()}`)],
    ['not a uuid', raw(`${AT}|not-a-uuid`)],
    ['SQL in the id', raw(`${AT}|${ID}'; drop table x; --`)],
  ])('refuses %s', (_name, value) => {
    expect(decodeActivityCursor(value)).toBeUndefined();
  });

  it('refuses a non-canonical spelling of a valid cursor (trailing bits)', () => {
    const cursor = encodeActivityCursor({ occurredAt: AT, id: ID });
    // A different last character can decode to the same bytes; only the canonical one is accepted.
    const variants = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
      .split('')
      .map((c) => cursor.slice(0, -1) + c)
      .filter((v) => v !== cursor);
    for (const variant of variants) {
      const decoded = decodeActivityCursor(variant);
      if (decoded) expect(encodeActivityCursor(decoded)).toBe(variant);
    }
  });
});

describe('activity query (SCRUM-82, D72)', () => {
  it('defaults: everything optional', () => {
    expect(activityQuerySchema.parse({})).toEqual({});
  });

  it('category all | mine | circle', () => {
    for (const category of ['all', 'mine', 'circle']) expect(field({ category })).toBe('ok');
    for (const category of ['', 'ALL', 'others', ['all', 'mine']]) {
      expect(field({ category })).toBe('category');
    }
  });

  it(`limit 1-${ACTIVITY_MAX_LIMIT}, integers only`, () => {
    expect(activityQuerySchema.parse({ limit: '1' })).toEqual({ limit: 1 });
    expect(activityQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
    for (const limit of ['0', '51', '-1', '2.5', 'ten', '', ['5', '6']]) {
      expect(field({ limit })).toBe('limit');
    }
  });

  it('before: the cursor alphabet only', () => {
    expect(field({ before: encodeActivityCursor({ occurredAt: AT, id: ID }) })).toBe('ok');
    for (const before of ['', 'a b', 'abc=', 'x'.repeat(201), ['a', 'b']]) {
      expect(field({ before })).toBe('before');
    }
  });

  it('checks category, then before, then limit', () => {
    expect(field({ category: 'x', before: '=', limit: '0' })).toBe('category');
    expect(field({ before: '=', limit: '0' })).toBe('before');
  });
});
