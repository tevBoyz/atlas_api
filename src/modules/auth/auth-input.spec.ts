import { DomainError } from '../../common/errors';
import {
  authPhoneFrom,
  deviceFrom,
  identifierFrom,
  loginFrom,
  meetsPasswordPolicy,
  optionalInstallationId,
  signupEmailFrom,
} from './auth-input';

/** Validation of the auth bodies (API-100-52/54): D5a, the lockout identifier rules, devices. */
function codeOf(fn: () => unknown): { code: string; field: unknown } {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, field: error.details.field };
    throw error;
  }
  throw new Error('expected a DomainError');
}

const DEVICE = { platform: 'ios', app_version: ' 2.1.0 ' };

describe('auth input', () => {
  describe('D5a password policy', () => {
    it.each([
      ['Abcdefg1', true],
      ['abcdefg1', false],
      ['ABCDEFG1', false],
      ['Abcdefgh', false],
      ['Ab1', false],
      ['Ab1' + 'x'.repeat(125), true],
      ['Ab1' + 'x'.repeat(126), false],
      ['Äbcdefg1', false],
    ])('%s → %s', (password, ok) => {
      expect(meetsPasswordPolicy(password)).toBe(ok);
    });
  });

  describe('login identifier (rules of _login_lockout_resolve_key)', () => {
    it.each<[unknown, unknown, string, string]>([
      ['a@b.test', '+12015550101', 'login_lockout:identifier_exclusive', 'email'],
      [undefined, undefined, 'login_lockout:identifier_required', 'email'],
      [null, null, 'login_lockout:identifier_required', 'email'],
      ['   ', undefined, 'login_lockout:email_required', 'email'],
      ['', undefined, 'login_lockout:email_required', 'email'],
      ['no-at-sign', undefined, 'login_lockout:invalid_email', 'email'],
      [`${'a'.repeat(250)}@b.cd`, undefined, 'login_lockout:invalid_email', 'email'],
      [undefined, '  ', 'login_lockout:phone_required', 'phone'],
      [undefined, '12345', 'login_lockout:invalid_phone', 'phone'],
      [undefined, '+0123456789', 'login_lockout:invalid_phone', 'phone'],
      [7, undefined, 'validation:invalid_request', 'email'],
    ])('email %p phone %p → %s', (email, phone, code, field) => {
      expect(codeOf(() => identifierFrom(email, phone))).toEqual({ code, field });
    });

    it('normalizes like the SQL: lower(trim(email)); phone digits get a +', () => {
      expect(identifierFrom('  Ada@Example.TEST ', null)).toEqual({
        kind: 'email',
        email: 'ada@example.test',
      });
      expect(identifierFrom(null, ' 12015550101 ')).toEqual({
        kind: 'phone',
        phone: '+12015550101',
      });
    });

    it('login body: identifier first, then password, then device', () => {
      expect(codeOf(() => loginFrom({ password: 'x', device: DEVICE }, null)).code).toBe(
        'login_lockout:identifier_required',
      );
      expect(codeOf(() => loginFrom({ email: 'a@b.test', device: DEVICE }, null))).toEqual({
        code: 'validation:invalid_request',
        field: 'password',
      });
      expect(codeOf(() => loginFrom({ email: 'a@b.test', password: 'x' }, null))).toEqual({
        code: 'auth:invalid_device',
        field: 'device',
      });
      expect(loginFrom({ email: 'a@b.test', password: 'x', device: DEVICE }, null).device).toEqual({
        platform: 'ios',
        app_version: '2.1.0',
        device_name: null,
        installation_id: null,
      });
    });
  });

  describe('sign-up values', () => {
    it('email: trimmed, lower-case, needs a dot in the domain', () => {
      expect(signupEmailFrom(' Ada@Example.Test ')).toBe('ada@example.test');
      expect(codeOf(() => signupEmailFrom('ada@localhost')).code).toBe('auth:invalid_email');
    });

    it('phone: strict +E.164 after normalization', () => {
      expect(authPhoneFrom('12015550101')).toBe('+12015550101');
      expect(codeOf(() => authPhoneFrom('+1 201 555 0101')).code).toBe('auth:invalid_phone');
    });
  });

  describe('device', () => {
    it.each<[unknown, string]>([
      [null, 'device'],
      [{ platform: 'web', app_version: '1' }, 'device.platform'],
      [{ platform: 'ios', app_version: '  ' }, 'device.app_version'],
      [{ platform: 'ios', app_version: '1', device_name: 3 }, 'device.device_name'],
      [{ platform: 'ios', app_version: '1', device_name: 'x'.repeat(101) }, 'device.device_name'],
    ])('%p → auth:invalid_device (%s)', (device, field) => {
      expect(codeOf(() => deviceFrom(device, null))).toEqual({
        code: 'auth:invalid_device',
        field,
      });
    });

    it('installation id header: optional, a UUID, stored lower-case', () => {
      expect(optionalInstallationId(undefined)).toBeNull();
      expect(optionalInstallationId('00000000-0000-4000-8000-00000000ABCD')).toBe(
        '00000000-0000-4000-8000-00000000abcd',
      );
      expect(codeOf(() => optionalInstallationId('nope'))).toEqual({
        code: 'auth:invalid_device',
        field: 'x-atlas-installation-id',
      });
    });
  });
});
