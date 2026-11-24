import { AUDIT_ACTIONS } from './audit.actions';
import { sanitizeAuditDetail } from './audit.detail';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

describe('Audit actions (API-100-14 AC3)', () => {
  it('lists the Epic 100 actions', () => {
    expect(AUDIT_ACTIONS).toHaveLength(32);
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'incident.created',
        'circle.member.left',
        'profile.setup_completed',
        'auth.login.failure',
        'auth.session.exchanged',
        'auth.password.changed',
        'auth.phone.changed',
        'profile.medical_item.added',
        'profile.medical_item.updated',
        'profile.medical_item.deleted',
        'incident.response_set',
        'incident.closed',
      ]),
    );
  });
});

describe('sanitizeAuditDetail (API-100-14 AC4)', () => {
  it('keeps safe values', () => {
    const detail = {
      recipient_count: 3,
      location_source: 'current',
      outcome: 'created',
      renotified: true,
      previous: null,
      member_ids: [ID],
      at: '2026-11-18T10:00:00.123Z',
      nested: { status: 'active' },
    };
    expect(sanitizeAuditDetail(detail)).toEqual({ detail, stripped: [] });
  });

  it('does not modify its input', () => {
    const input = { phone: '+12015550101', status: 'active' };
    sanitizeAuditDetail(input);
    expect(input).toEqual({ phone: '+12015550101', status: 'active' });
  });

  it('defaults to an empty object', () => {
    expect(sanitizeAuditDetail().detail).toEqual({});
  });

  it.each([
    // Medical and share fields
    ['emergency_type', 'medical'],
    ['emergency_type', 'fire'],
    ['emergencyType', 'medical'],
    ['blood_type', 'O+'],
    ['allergies', 'nuts'],
    ['medical_conditions', 'asthma'],
    ['emergency_notes', 'text'],
    ['emergency_contact_phone', '+12015550101'],
    ['incident_notes', 'text'],
    ['date_of_birth', '1990-01-15'],
    ['share_payload', { blood_type: 'O+' }],
    ['share_blood_type', true],
    ['share_phone', true],
    ['resident_phone', '+2207000001'],
    ['sharedFields', ['blood_type']],
    // Tokens and secrets
    ['invite_token', 'abc'],
    ['access_token', 'abc'],
    ['refreshToken', 'abc'],
    ['password', 'abc'],
    ['otp', '123456'],
    ['authorization', 'Bearer abc'],
    ['api_key', 'abc'],
    // Phone numbers, emails and names
    ['phone', '+12015550101'],
    ['contactPhone', '12015550101'],
    ['Phone-Number', '12015550101'],
    ['email', 'ada@example.test'],
    ['display_name', 'Ada'],
    // Coordinates
    ['lat', 13.4549],
    ['lng', -16.579],
    ['location_lat', 13.4549],
    ['longitude', -16.579],
    ['coordinates', [13.4549, -16.579]],
    ['location', { lat: 1, lng: 2 }],
    ['accuracy_m', 12],
  ])('strips the key %s', (key, value) => {
    expect(sanitizeAuditDetail({ [key]: value, status: 'ok' })).toEqual({
      detail: { status: 'ok' },
      stripped: [key],
    });
  });

  it('never stores emergency_type, at any depth, and does not echo its value', () => {
    const result = sanitizeAuditDetail({
      emergency_type: 'medical',
      nested: { emergency_type: 'medical', status: 'active' },
      list: [{ emergency_type: 'medical', ok: 1 }],
    });
    expect(result).toEqual({
      detail: { nested: { status: 'active' }, list: [{ ok: 1 }] },
      stripped: ['emergency_type', 'nested.emergency_type', 'list[0].emergency_type'],
    });
    expect(JSON.stringify(result)).not.toContain('medical');
  });

  it.each([
    ['a full phone number', '+12015550101'],
    ['a phone number without +', '12015550101'],
    ['a formatted phone number', '(201) 555-0101'],
    ['a phone number inside text', 'called 2015550101 twice'],
    ['an email', 'ada@example.test'],
    ['a JWT', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghij'].join('.')],
    ['a bearer token', 'Bearer abcdefghijklmnop'],
    ['an invite token', 'a'.repeat(64)],
    ['coordinates', '13.45490, -16.57900'],
    ['free text longer than the limit', 'word '.repeat(50)],
  ])('strips a value holding %s, under any key', (_label, value) => {
    expect(sanitizeAuditDetail({ reason: value })).toEqual({ detail: {}, stripped: ['reason'] });
  });

  it.each([
    ['a fraction (coordinate)', 13.4549],
    ['a phone number as an integer', 12015550101],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('strips a number that is %s', (_label, value) => {
    expect(sanitizeAuditDetail({ value }).detail).toEqual({});
  });

  it('applies the rules at every depth and inside arrays', () => {
    const { detail, stripped } = sanitizeAuditDetail({
      a: { b: { phone: '+12015550101', ok: 1 } },
      list: [{ lat: 1, ok: 2 }, '+12015550101', 'fine'],
    });
    expect(detail).toEqual({ a: { b: { ok: 1 } }, list: [{ ok: 2 }, 'fine'] });
    expect(stripped).toEqual(['a.b.phone', 'list[0].lat', 'list[1]']);
  });

  it('drops structures too deep or too long, and non-plain objects', () => {
    const { detail } = sanitizeAuditDetail({
      deep: { a: { b: { c: { d: 1 } } } },
      long: Array.from({ length: 21 }, (_, i) => i),
      date: new Date(),
      map: new Map([['a', 1]]),
    });
    expect(detail).toEqual({ deep: { a: { b: {} } } });
  });

  it('reports key paths only, never the stripped values', () => {
    const { stripped } = sanitizeAuditDetail({ phone: '+12015550101', note: 'secret text' });
    expect(JSON.stringify(stripped)).not.toContain('5550101');
    expect(JSON.stringify(stripped)).not.toContain('secret text');
  });
});
