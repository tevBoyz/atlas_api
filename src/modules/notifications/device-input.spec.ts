import { DomainError } from '../../common/errors';
import { scrub } from '../../observability/scrubber';
import {
  APP_VERSION_MAX,
  deviceRegistrationFromBody,
  PUSH_TOKEN_MAX,
  PUSH_TOKEN_STATUSES,
  pushTokenHash,
  pushTokenStatus,
  requireInstallationId,
} from './device-input';

const TOKEN = 'fcm-token-AbC123:xyz_-.';

function errorOf(fn: () => unknown): { code: string; field: unknown } {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, field: error.details.field };
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('device input (API-100-44, D22)', () => {
  describe('X-Atlas-Installation-Id', () => {
    it('accepts a UUID in either case and stores it lowercase', () => {
      expect(requireInstallationId('6F9619FF-8B86-4D11-B42D-00C04FC964FF')).toBe(
        '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
      );
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not a uuid', 'device-1'],
      ['braces', '{6f9619ff-8b86-4d11-b42d-00c04fc964ff}'],
      ['no hyphens', '6f9619ff8b864d11b42d00c04fc964ff'],
      [
        'repeated header (joined)',
        '6f9619ff-8b86-4d11-b42d-00c04fc964ff, 6f9619ff-8b86-4d11-b42d-00c04fc964ff',
      ],
      ['array', ['6f9619ff-8b86-4d11-b42d-00c04fc964ff']],
    ])('%s → 422 user_devices:invalid_installation_id', (_name, value) => {
      expect(errorOf(() => requireInstallationId(value))).toEqual({
        code: 'user_devices:invalid_installation_id',
        field: 'x-atlas-installation-id',
      });
    });
  });

  describe('body', () => {
    const base = { platform: 'android', app_version: '1.2.3' };

    it('platform and version only: the stored token is kept (push undefined)', () => {
      expect(deviceRegistrationFromBody(base)).toEqual({
        platform: 'android',
        app_version: '1.2.3',
      });
    });

    it('a token with its provider', () => {
      expect(
        deviceRegistrationFromBody({ ...base, push_provider: 'fcm', push_token: TOKEN }),
      ).toEqual({ ...base, push: { provider: 'fcm', token: TOKEN } });
    });

    it('null token (and null or missing provider) clears it', () => {
      expect(deviceRegistrationFromBody({ ...base, push_token: null }).push).toBeNull();
      expect(
        deviceRegistrationFromBody({ ...base, push_token: null, push_provider: null }).push,
      ).toBeNull();
      expect(deviceRegistrationFromBody({ ...base, push_provider: null }).push).toBeNull();
    });

    it('trims app_version; ignores unknown keys', () => {
      expect(
        deviceRegistrationFromBody({ platform: 'ios', app_version: ' 2.0.0+15 ', extra: 1 }),
      ).toEqual({ platform: 'ios', app_version: '2.0.0+15' });
    });

    it.each([
      ['not an object', [], 'validation:invalid_request', 'body'],
      ['null body', null, 'validation:invalid_request', 'body'],
      ['missing platform', { app_version: '1' }, 'user_devices:invalid_platform', 'platform'],
      [
        'wrong platform',
        { platform: 'web', app_version: '1' },
        'user_devices:invalid_platform',
        'platform',
      ],
      [
        'upper-case platform',
        { platform: 'IOS', app_version: '1' },
        'user_devices:invalid_platform',
        'platform',
      ],
      ['missing version', { platform: 'ios' }, 'user_devices:invalid_app_version', 'app_version'],
      [
        'blank version',
        { platform: 'ios', app_version: '  ' },
        'user_devices:invalid_app_version',
        'app_version',
      ],
      [
        'number version',
        { platform: 'ios', app_version: 2 },
        'user_devices:invalid_app_version',
        'app_version',
      ],
      [
        'too long version',
        { platform: 'ios', app_version: 'x'.repeat(APP_VERSION_MAX + 1) },
        'user_devices:invalid_app_version',
        'app_version',
      ],
      [
        'control char version',
        { platform: 'ios', app_version: '1\n2' },
        'user_devices:invalid_app_version',
        'app_version',
      ],
      [
        'wrong provider',
        { ...base, push_provider: 'gcm', push_token: TOKEN },
        'user_devices:invalid_push_provider',
        'push_provider',
      ],
      [
        'token without provider',
        { ...base, push_token: TOKEN },
        'user_devices:invalid_push_provider',
        'push_provider',
      ],
      [
        'provider without token',
        { ...base, push_provider: 'apns' },
        'user_devices:invalid_push_token',
        'push_token',
      ],
      [
        'empty token',
        { ...base, push_provider: 'fcm', push_token: '' },
        'user_devices:invalid_push_token',
        'push_token',
      ],
      [
        'token with a space',
        { ...base, push_provider: 'fcm', push_token: 'a b' },
        'user_devices:invalid_push_token',
        'push_token',
      ],
      [
        'number token',
        { ...base, push_provider: 'fcm', push_token: 12 },
        'user_devices:invalid_push_token',
        'push_token',
      ],
      [
        'too long token',
        { ...base, push_provider: 'fcm', push_token: 'a'.repeat(PUSH_TOKEN_MAX + 1) },
        'user_devices:invalid_push_token',
        'push_token',
      ],
    ])('%s → %s', (_name, body, code, field) => {
      expect(errorOf(() => deviceRegistrationFromBody(body))).toEqual({ code, field });
    });

    it('the first failing field wins (platform before app_version before push fields)', () => {
      expect(
        errorOf(() =>
          deviceRegistrationFromBody({ platform: 'x', app_version: '', push_token: 'a b' }),
        ).code,
      ).toBe('user_devices:invalid_platform');
    });

    it('a rejected token never appears in the error', () => {
      try {
        deviceRegistrationFromBody({ ...base, push_provider: 'fcm', push_token: `${TOKEN} x` });
        throw new Error('expected a DomainError');
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain(TOKEN);
        expect((error as Error).message).not.toContain(TOKEN);
      }
    });
  });

  it('the log scrubber redacts push tokens', () => {
    const scrubbed = JSON.stringify(scrub({ push_token: TOKEN, body: { push_token: TOKEN } }));
    expect(scrubbed).not.toContain(TOKEN);
  });
});

describe('push_token_status and the dead-token hash (D69, gap 49)', () => {
  it.each([
    [{ refused: true, stored: false }, 'invalid'],
    [{ refused: true, stored: true }, 'invalid'],
    [{ refused: false, stored: true }, 'ok'],
    [{ refused: false, stored: false }, 'none'],
  ] as const)('%o -> %s', (outcome, status) => {
    expect(pushTokenStatus(outcome)).toBe(status);
  });

  it('the statuses are exactly ok, none, invalid', () => {
    expect(PUSH_TOKEN_STATUSES).toEqual(['ok', 'none', 'invalid']);
  });

  it('the hash is the SHA-256 hex of the token, never the token itself', () => {
    const hash = pushTokenHash(TOKEN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(TOKEN);
    expect(pushTokenHash(TOKEN)).toBe(hash);
    expect(pushTokenHash(`${TOKEN}x`)).not.toBe(hash);
    // Known vector: SHA-256 of "abc".
    expect(pushTokenHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('the log scrubber redacts the hash column too', () => {
    const hash = pushTokenHash(TOKEN);
    expect(JSON.stringify(scrub({ push_token_invalid_hash: hash }))).not.toContain(hash);
  });
});
