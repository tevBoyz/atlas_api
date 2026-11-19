import { DomainError } from '../../common/errors';
import { assertArgumentsConvert, parseAttachLocationBody, pendingChecks } from './location-input';

const field = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('validation:invalid_request');
    return (error as DomainError).details.field;
  }
  return undefined;
};

describe('parseAttachLocationBody (API-100-17)', () => {
  it('a current fix: numbers become float8 input text, captured_at waits for Postgres', () => {
    const parsed = parseAttachLocationBody({
      location_source: 'current',
      location_lat: 9.03,
      location_lng: -0,
      location_accuracy_m: 1e21,
      location_captured_at: '2026-11-19T10:00:00Z',
    });
    expect(parsed.args).toEqual({
      source: 'current',
      lat: '9.03',
      lng: '-0',
      accuracy: '1e+21',
      capturedAt: '2026-11-19T10:00:00Z',
    });
    expect(pendingChecks(parsed.conversions)).toEqual([
      {
        field: 'location_captured_at',
        state: 'check',
        text: '2026-11-19T10:00:00Z',
        type: 'timestamp with time zone',
      },
    ]);
  });

  it('missing and null are both SQL null; unknown keys are ignored', () => {
    expect(parseAttachLocationBody({ location_source: 'unavailable', other: 1 }).args).toEqual({
      source: 'unavailable',
      lat: null,
      lng: null,
      accuracy: null,
      capturedAt: null,
    });
    expect(
      parseAttachLocationBody({ location_source: null, location_lat: null }).args.source,
    ).toBeNull();
  });

  it('a non-string source is passed as its JSON text (never one of the three sources)', () => {
    expect(parseAttachLocationBody({ location_source: 5 }).args.source).toBe('5');
    expect(parseAttachLocationBody({ location_source: { a: 1 } }).args.source).toBe('{"a":1}');
  });

  it('numeric strings are left for float8in (NaN, Infinity, padding)', () => {
    const parsed = parseAttachLocationBody({
      location_source: 'last_known',
      location_lat: ' 9.03 ',
      location_lng: 'NaN',
      location_accuracy_m: 'Infinity',
    });
    expect(pendingChecks(parsed.conversions).map((c) => [c.field, c.text, c.type])).toEqual([
      ['location_lat', ' 9.03 ', 'double precision'],
      ['location_lng', 'NaN', 'double precision'],
      ['location_accuracy_m', 'Infinity', 'double precision'],
    ]);
  });

  it.each([
    ['source with NUL', { location_source: 'current\u0000' }, 'location_source'],
    ['source with an unpaired surrogate', { location_source: '\ud800' }, 'location_source'],
    ['lat Infinity (1e400 in JSON)', { location_lat: Infinity }, 'location_lat'],
    ['lat a boolean', { location_lat: true }, 'location_lat'],
    ['lng an object', { location_lng: {} }, 'location_lng'],
    ['accuracy an array', { location_accuracy_m: [1] }, 'location_accuracy_m'],
    ['captured_at a number', { location_captured_at: 20261119 }, 'location_captured_at'],
    [
      'captured_at with a lone low surrogate',
      { location_captured_at: 'x\udc00' },
      'location_captured_at',
    ],
  ])('%s cannot convert', (_name, body, expected) => {
    const parsed = parseAttachLocationBody(body);
    expect(field(() => assertArgumentsConvert(parsed.conversions, []))).toBe(expected);
  });

  it('a paired surrogate (an emoji) is text Postgres can hold', () => {
    const parsed = parseAttachLocationBody({ location_source: '\u{1F600}' });
    expect(() => assertArgumentsConvert(parsed.conversions, [])).not.toThrow();
  });

  it('the first argument that fails wins, in parameter order, across both kinds of failure', () => {
    const parsed = parseAttachLocationBody({
      location_source: 'current',
      location_lat: 'x',
      location_lng: true,
      location_captured_at: 'y',
    });
    expect(field(() => assertArgumentsConvert(parsed.conversions, [false, false]))).toBe(
      'location_lat',
    );
    expect(field(() => assertArgumentsConvert(parsed.conversions, [true, false]))).toBe(
      'location_lng',
    );
  });

  it('every check passing → no error', () => {
    const parsed = parseAttachLocationBody({ location_lat: '1', location_captured_at: 'now' });
    expect(() => assertArgumentsConvert(parsed.conversions, [true, true])).not.toThrow();
  });

  it.each([null, [], 'x', 5, undefined])('a body that is %p is 422 on field body', (body) => {
    expect(field(() => parseAttachLocationBody(body))).toBe('body');
  });
});
