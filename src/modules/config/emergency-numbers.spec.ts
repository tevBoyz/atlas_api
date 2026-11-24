import { DEFAULT_EMERGENCY_NUMBERS, emergencyServicesFrom } from './emergency-numbers';

const GM = [
  { service: 'ambulance', label: 'Ambulance', number: '116' },
  { service: 'police', label: 'Police', number: '117' },
  { service: 'fire_rescue', label: 'Fire and Rescue', number: '119' },
];

describe('emergencyServicesFrom (SCRUM-54, D60)', () => {
  it('returns the seeded Gambia numbers in the fixed order', () => {
    expect(emergencyServicesFrom({ GM }, 'GM')).toEqual(GM);
  });

  it('always orders ambulance, police, fire_rescue, whatever the stored order', () => {
    expect(emergencyServicesFrom({ GM: [GM[2], GM[1], GM[0]] }, 'GM')).toEqual(GM);
  });

  it('falls back to the built-in numbers when the row is missing or not an object', () => {
    for (const value of [undefined, null, '"x"', 3, [GM]]) {
      expect(emergencyServicesFrom(value, 'GM')).toEqual(DEFAULT_EMERGENCY_NUMBERS.GM);
    }
    expect(emergencyServicesFrom(undefined, 'SN')).toEqual([]);
  });

  it('a country without an entry, or a non-array entry, has no numbers', () => {
    expect(emergencyServicesFrom({ GM }, 'SN')).toEqual([]);
    expect(emergencyServicesFrom({ GM: {} }, 'GM')).toEqual([]);
    expect(emergencyServicesFrom({ GM: [] }, 'GM')).toEqual([]);
  });

  it('looks numbers up by country (another region is configuration only)', () => {
    const sn = [{ service: 'police', label: 'Police', number: '17' }];
    expect(emergencyServicesFrom({ GM, SN: sn }, 'SN')).toEqual(sn);
  });

  it('skips invalid entries, trims, and keeps the first entry of a repeated service', () => {
    expect(
      emergencyServicesFrom(
        {
          GM: [
            null,
            'x',
            { service: 'coast_guard', label: 'Coast', number: '199' },
            { service: 'police', label: '  ', number: '117' },
            { service: 'police', label: 'Police', number: '11 7' },
            { service: 'police', label: 'Police', number: 117 },
            { service: 'police', label: 'x'.repeat(41), number: '117' },
            { service: 'fire_rescue', label: ' Fire and Rescue ', number: ' 119 ' },
            { service: 'fire_rescue', label: 'Second', number: '118' },
            { service: 'ambulance', label: 'Ambulance', number: '+220116' },
          ],
        },
        'GM',
      ),
    ).toEqual([
      { service: 'ambulance', label: 'Ambulance', number: '+220116' },
      { service: 'fire_rescue', label: 'Fire and Rescue', number: '119' },
    ]);
  });
});
