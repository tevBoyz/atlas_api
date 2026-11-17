import { maskEmail, maskPhone, REDACTED, scrub, scrubString } from './scrubber';

/** Fake values only (fictional 555 range, example.test domain). */
const PHONE = '+12015550101';
const EMAIL = 'ada.lovelace@example.test';
/** Fake JWT-shaped value, assembled at runtime so secret scanners do not flag the source. */
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLWZha2U'].join(
  '.',
);

describe('scrubber (API-100-06 AC2)', () => {
  describe('masks', () => {
    it('masks phone numbers to the last two digits', () => {
      expect(maskPhone(PHONE)).toBe('***01');
      expect(maskPhone('+1 (201) 555-0104')).toBe('***04');
      expect(maskPhone('1')).toBe('***');
    });

    it('masks emails to first character and top-level domain', () => {
      expect(maskEmail(EMAIL)).toBe('a***@***.test');
      expect(maskEmail('nope')).toBe('***');
    });
  });

  describe('keys', () => {
    it('redacts authorization, cookies, tokens, passwords, secrets and OTP codes', () => {
      const out = scrub({
        authorization: `Bearer ${JWT}`,
        Authorization: 'Basic abc',
        cookie: 'sb=1',
        'set-cookie': ['a=1'],
        access_token: 'a',
        refresh_token: 'b',
        invite_token: 'c',
        token: 'd',
        password: 'Secret123',
        new_password: 'Secret456',
        SUPABASE_JWT_SECRET: 'x',
        otp: '123456',
        code: '123456',
        otp_code: 987654,
        api_key: 'k',
      });
      for (const value of Object.values(out)) expect(value).toBe(REDACTED);
    });

    it('keeps non-OTP `code` values (error codes, SQLSTATEs, HTTP status codes)', () => {
      expect(
        scrub({
          code: 'submit_emergency_alert:invalid_type',
          sqlstate_code: '23505',
          status_code: 404,
        }),
      ).toEqual({
        code: 'submit_emergency_alert:invalid_type',
        sqlstate_code: '23505',
        status_code: 404,
      });
    });

    it('redacts share_payload and medical / emergency fields', () => {
      const out = scrub({
        share_payload: { blood_type: 'O+', allergies: 'nuts' },
        blood_type: 'O+',
        allergies: 'nuts',
        medical_conditions: 'asthma',
        emergency_notes: 'note',
        emergency_preferred_language: 'wo',
        emergency_contact_full_name: 'Ben',
        emergency_contact_relationship: 'friend',
        emergency_contact_phone: PHONE,
        emergency_contact_email: EMAIL,
        incident_notes: 'gate code 1234',
        date_of_birth: '1990-01-01',
        full_name: 'Ada Lovelace',
        display_name: 'Ada',
        resident_name: 'Ada',
        owner_name: 'Ada',
        invite_url: 'io.supabase.atlasmobile://invite/abcdefghijkl',
      });
      for (const value of Object.values(out)) expect(value).toBe(REDACTED);
    });

    it('keeps boolean share flags', () => {
      expect(scrub({ share_blood_type: true, share_emergency_contact_phone: false })).toEqual({
        share_blood_type: true,
        share_emergency_contact_phone: false,
      });
    });

    it('masks phone and email fields, including header-style names', () => {
      expect(
        scrub({ phone: PHONE, p_phone: PHONE, 'X-Phone': PHONE, email: EMAIL, p_email: EMAIL }),
      ).toEqual({
        phone: '***01',
        p_phone: '***01',
        'X-Phone': '***01',
        email: 'a***@***.test',
        p_email: 'a***@***.test',
      });
    });

    it('omits coordinates entirely', () => {
      const out = scrub({
        location_lat: 13.45,
        location_lng: -16.57,
        p_location_lat: 1,
        lat: 1,
        lng: 2,
        latitude: 3,
        longitude: 4,
        location_accuracy_m: 12,
        location_source: 'gps',
      });
      expect(out).toEqual({ location_accuracy_m: 12, location_source: 'gps' });
    });
  });

  describe('free text', () => {
    it('scrubs bearer tokens, JWTs, invite tokens, emails and phones in strings', () => {
      const text = scrubString(
        `auth Bearer ${JWT} raw ${JWT} /v1/invites/abcDEF123456 mail ${EMAIL} call ${PHONE} or +1 201 555 0102`,
      );
      expect(text).not.toContain(JWT);
      expect(text).not.toContain('abcDEF123456');
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain('555 0102');
      expect(text).toContain(`Bearer ${REDACTED}`);
      expect(text).toContain(`/v1/invites/${REDACTED}`);
      expect(text).toContain('a***@***.test');
      expect(text).toContain('***01');
    });

    it('leaves UUIDs, timestamps and plain numbers alone', () => {
      const text =
        'id 00000000-0000-4000-8000-000000000001 at 2026-11-17T10:15:00.000Z took 12345 ms';
      expect(scrubString(text)).toBe(text);
    });
  });

  describe('structure', () => {
    it('recurses into nested objects and arrays', () => {
      expect(scrub({ a: [{ phone: PHONE }, { b: { password: 'x' } }] })).toEqual({
        a: [{ phone: '***01' }, { b: { password: REDACTED } }],
      });
    });

    it('turns errors into plain scrubbed objects, including cause', () => {
      const error = new Error(`failed for ${EMAIL}`, { cause: new Error(`retry ${PHONE}`) });
      const out = scrub({ err: error }) as unknown as { err: Record<string, unknown> };
      expect(out.err.type).toBe('Error');
      expect(out.err.message).toBe('failed for a***@***.test');
      expect(String(out.err.stack)).not.toContain(EMAIL);
      expect((out.err.cause as Record<string, unknown>).message).toBe('retry ***01');
    });

    it('handles circular references and does not mutate the input', () => {
      const input: Record<string, unknown> = { phone: PHONE };
      input.self = input;
      const out = scrub(input);
      expect(out.self).toBe('[Circular]');
      expect(input.phone).toBe(PHONE);
    });

    it('keeps null, undefined, numbers and booleans', () => {
      expect(scrub({ a: null, b: undefined, c: 1, d: true, phone: null })).toEqual({
        a: null,
        b: undefined,
        c: 1,
        d: true,
        phone: null,
      });
    });
  });
});
