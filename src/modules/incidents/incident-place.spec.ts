import {
  countryCodeOf,
  hasPlace,
  PLACE_NAME_MAX,
  placeFromBody,
  placeNameOf,
} from './incident-place';

describe('incident place input (Stage 2 [B6] / [B9])', () => {
  it('keeps a usable name: trimmed, white space collapsed, up to 120 characters', () => {
    expect(placeNameOf('  Serrekunda  ')).toBe('Serrekunda');
    expect(placeNameOf('Kairaba\tAvenue,\n Serrekunda')).toBe('Kairaba Avenue, Serrekunda');
    expect(placeNameOf('é'.repeat(PLACE_NAME_MAX))).toBe('é'.repeat(PLACE_NAME_MAX));
  });

  it.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(PLACE_NAME_MAX + 1)],
    ['NUL', 'Banjul\u0000'],
    ['control character', 'Ban\u0007jul'],
    ['not a string', 42],
    ['null', null],
  ])('ignores a name that is %s', (_label, value) => {
    expect(placeNameOf(value)).toBeUndefined();
  });

  it('country: two letters, stored uppercase; anything else ignored', () => {
    expect(countryCodeOf('gm')).toBe('GM');
    expect(countryCodeOf(' ET ')).toBe('ET');
    for (const bad of ['GMB', 'G', '12', 'G1', '', null, 7])
      expect(countryCodeOf(bad)).toBeUndefined();
  });

  it('reads only the two keys of an object body; invalid ones are left out', () => {
    expect(
      placeFromBody({ place_name: 'Bakau', country_code: 'gm', emergency_type: 'fire' }),
    ).toEqual({ place_name: 'Bakau', country_code: 'GM' });
    expect(placeFromBody({ place_name: '', country_code: 'Gambia' })).toEqual({});
    expect(placeFromBody(null)).toEqual({});
    expect(placeFromBody(['x'])).toEqual({});
    expect(hasPlace({})).toBe(false);
    expect(hasPlace({ country_code: 'GM' })).toBe(true);
  });
});
