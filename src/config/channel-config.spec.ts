import { generateKeyPairSync } from 'node:crypto';

import { ConfigValidationError, parseConfig } from './config.schema';

/** A throwaway signing key, generated at runtime (production needs one, API-100-51). */
const AUTH_KEY = {
  ...(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as Record<
    string,
    string
  >),
  kid: 'k1',
};

/** Fake values only. */
const FAKE_SECRET = 'fake-channel-secret-SHOULD-NEVER-APPEAR';
const FCM = {
  FCM_PROJECT_ID: 'fake-project',
  FCM_CLIENT_EMAIL: 'fake@fake-project.iam.example.test',
  FCM_PRIVATE_KEY: FAKE_SECRET,
};
const APNS = {
  APNS_KEY_ID: 'FAKEKEY123',
  APNS_TEAM_ID: 'FAKETEAM12',
  APNS_PRIVATE_KEY: FAKE_SECRET,
  APNS_BUNDLE_ID: 'test.example.atlas',
};
const TWILIO = {
  TWILIO_ACCOUNT_SID: 'ACfake',
  TWILIO_AUTH_TOKEN: FAKE_SECRET,
  TWILIO_FROM_NUMBER: '+12015550100',
};
const SENDGRID = {
  CHANNEL_EMAIL_ADAPTER: 'sendgrid',
  SENDGRID_API_KEY: FAKE_SECRET,
  EMAIL_FROM_ADDRESS: 'alerts@example.test',
};
const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://fake:fake@localhost:5432/atlas',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_JWT_SECRET: 'fake-jwt-secret-0123456789-abcdefghij',
  SUPABASE_JWT_ISSUER: 'https://example.supabase.co/auth/v1',
  SUPABASE_STORAGE_SERVICE_KEY: 'fake-storage-key',
  AUTH_JWT_KEYS: JSON.stringify([AUTH_KEY]),
  AUTH_JWT_ACTIVE_KID: 'k1',
};

function problemsOf(env: Record<string, string>): { keys: string[]; message: string } {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return { keys: error.keys, message: error.message };
    }
    throw error;
  }
  return { keys: [], message: '' };
}

describe('channel and job configuration (API-100-45 to 47, D23-D25)', () => {
  it('defaults: every channel off, fake adapters, no worker mode, 3 retries from 2 s', () => {
    const config = parseConfig({});
    expect(config).toMatchObject({
      WORKER: false,
      CHANNEL_PUSH_ENABLED: false,
      CHANNEL_SMS_ENABLED: false,
      CHANNEL_EMAIL_ENABLED: false,
      CHANNEL_PUSH_ADAPTER: 'fake',
      CHANNEL_SMS_ADAPTER: 'fake',
      CHANNEL_SMS_TWILIO_HOLD_LIFTED: false,
      CHANNEL_EMAIL_ADAPTER: 'fake',
      SENDGRID_API_BASE_URL: 'https://api.sendgrid.com',
      NOTIFICATIONS_RETRY_ATTEMPTS: 3,
      NOTIFICATIONS_RETRY_BASE_DELAY_MS: 2000,
    });
  });

  it.each([
    ['1', true],
    ['true', true],
    ['0', false],
    ['false', false],
  ])('WORKER=%s', (raw, expected) => {
    expect(parseConfig({ WORKER: raw }).WORKER).toBe(expected);
  });

  it('the real push adapter needs the FCM keys, the APNs keys or both', () => {
    expect(problemsOf({ CHANNEL_PUSH_ADAPTER: 'real' }).keys).toEqual(
      expect.arrayContaining(['FCM_PROJECT_ID', 'APNS_KEY_ID']),
    );
    expect(problemsOf({ CHANNEL_PUSH_ADAPTER: 'real', ...FCM }).keys).toEqual([]);
    expect(problemsOf({ CHANNEL_PUSH_ADAPTER: 'real', ...APNS }).keys).toEqual([]);
    expect(problemsOf({ CHANNEL_PUSH_ADAPTER: 'real', ...FCM, ...APNS }).keys).toEqual([]);
  });

  it('a key set is all or none (names the missing keys, never a value)', () => {
    const { keys, message } = problemsOf({ FCM_PROJECT_ID: 'p', FCM_PRIVATE_KEY: FAKE_SECRET });
    expect(keys).toEqual(['FCM_CLIENT_EMAIL']);
    expect(message).not.toContain(FAKE_SECRET);
    expect(problemsOf({ APNS_KEY_ID: 'k' }).keys).toEqual([
      'APNS_TEAM_ID',
      'APNS_PRIVATE_KEY',
      'APNS_BUNDLE_ID',
    ]);
  });

  describe('Twilio hold (AC4 of API-100-46)', () => {
    it('the Twilio adapter is refused while the hold is on, even with every key', () => {
      const { keys, message } = problemsOf({ CHANNEL_SMS_ADAPTER: 'twilio', ...TWILIO });
      expect(keys).toEqual(['CHANNEL_SMS_ADAPTER']);
      expect(message).toContain('Twilio hold');
      expect(message).not.toContain(FAKE_SECRET);
    });

    it('lifting the hold still needs every Twilio key', () => {
      expect(
        problemsOf({ CHANNEL_SMS_ADAPTER: 'twilio', CHANNEL_SMS_TWILIO_HOLD_LIFTED: 'true' }).keys,
      ).toEqual(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']);
      expect(
        problemsOf({
          CHANNEL_SMS_ADAPTER: 'twilio',
          CHANNEL_SMS_TWILIO_HOLD_LIFTED: 'true',
          ...TWILIO,
        }).keys,
      ).toEqual([]);
    });

    it('SMS enabled on the fake adapter is allowed outside production (nothing leaves the process)', () => {
      expect(problemsOf({ CHANNEL_SMS_ENABLED: 'true' }).keys).toEqual([]);
    });
  });

  describe('SendGrid email adapter (D43)', () => {
    it('sendgrid needs the API key and the from address (named, key never echoed)', () => {
      expect(problemsOf({ CHANNEL_EMAIL_ADAPTER: 'sendgrid' }).keys).toEqual([
        'SENDGRID_API_KEY',
        'EMAIL_FROM_ADDRESS',
      ]);
      const { keys, message } = problemsOf({
        CHANNEL_EMAIL_ADAPTER: 'sendgrid',
        SENDGRID_API_KEY: FAKE_SECRET,
      });
      expect(keys).toEqual(['EMAIL_FROM_ADDRESS']);
      expect(message).not.toContain(FAKE_SECRET);
      expect(problemsOf(SENDGRID).keys).toEqual([]);
      expect(problemsOf({ ...SENDGRID, EMAIL_FROM_NAME: 'Atlas' }).keys).toEqual([]);
    });

    it('the key alone does nothing: the adapter stays fake unless CHANNEL_EMAIL_ADAPTER=sendgrid', () => {
      const config = parseConfig({ SENDGRID_API_KEY: FAKE_SECRET });
      expect(config.CHANNEL_EMAIL_ADAPTER).toBe('fake');
    });

    it.each([
      ['EMAIL_FROM_ADDRESS', 'not-an-address'],
      ['EMAIL_FROM_ADDRESS', 'Atlas <alerts@example.test>'],
      ['EMAIL_FROM_NAME', 'Atlas\r\nBcc: x@example.test'],
      ['EMAIL_FROM_NAME', 'x'.repeat(101)],
      ['SENDGRID_API_BASE_URL', 'ftp://api.sendgrid.com'],
      ['CHANNEL_EMAIL_ADAPTER', 'smtp'],
    ])('%s=%j is refused', (key, value) => {
      expect(problemsOf({ ...SENDGRID, [key]: value }).keys).toEqual([key]);
    });

    it('a local http base URL is allowed outside production only', () => {
      const local = { ...SENDGRID, SENDGRID_API_BASE_URL: 'http://127.0.0.1:4010' };
      expect(problemsOf(local).keys).toEqual([]);
      expect(problemsOf({ ...PRODUCTION, ...local }).keys).toEqual(['SENDGRID_API_BASE_URL']);
    });
  });

  describe('production', () => {
    it('channels off: valid', () => {
      expect(problemsOf(PRODUCTION).keys).toEqual([]);
    });

    it.each(['CHANNEL_PUSH_ENABLED', 'CHANNEL_SMS_ENABLED', 'CHANNEL_EMAIL_ENABLED'])(
      '%s=true on a fake adapter is refused',
      (key) => {
        expect(problemsOf({ ...PRODUCTION, [key]: 'true' }).keys).toEqual([key]);
      },
    );

    it('email enabled with SendGrid and its keys is valid (D43); the test mailbox stays refused', () => {
      expect(
        problemsOf({ ...PRODUCTION, CHANNEL_EMAIL_ENABLED: 'true', ...SENDGRID }).keys,
      ).toEqual([]);
      expect(
        problemsOf({
          ...PRODUCTION,
          CHANNEL_EMAIL_ENABLED: 'true',
          ...SENDGRID,
          AUTH_TEST_MAILBOX_ENABLED: 'true',
        }).keys,
      ).toEqual(['AUTH_TEST_MAILBOX_ENABLED']);
      expect(
        problemsOf({
          ...PRODUCTION,
          CHANNEL_EMAIL_ENABLED: 'true',
          CHANNEL_EMAIL_ADAPTER: 'sendgrid',
        }).keys,
      ).toEqual(['SENDGRID_API_KEY', 'EMAIL_FROM_ADDRESS']);
    });

    it('push enabled with the real adapter and keys is valid', () => {
      expect(
        problemsOf({
          ...PRODUCTION,
          CHANNEL_PUSH_ENABLED: 'true',
          CHANNEL_PUSH_ADAPTER: 'real',
          ...FCM,
        }).keys,
      ).toEqual([]);
    });
  });

  it('every retry must fit in 60 s: 3 retries from 2 s = 14 s ok; 3 from 9 s = 63 s refused', () => {
    expect(problemsOf({ NOTIFICATIONS_RETRY_BASE_DELAY_MS: '8500' }).keys).toEqual([]);
    expect(problemsOf({ NOTIFICATIONS_RETRY_BASE_DELAY_MS: '9000' }).keys).toEqual([
      'NOTIFICATIONS_RETRY_ATTEMPTS',
      'NOTIFICATIONS_RETRY_BASE_DELAY_MS',
    ]);
    expect(problemsOf({ NOTIFICATIONS_RETRY_ATTEMPTS: '0' }).keys).toEqual([]);
  });

  it('TWILIO_FROM_NUMBER must be E.164 (named, value not echoed)', () => {
    const { keys, message } = problemsOf({ TWILIO_FROM_NUMBER: '2015550100' });
    expect(keys).toEqual(['TWILIO_FROM_NUMBER']);
    expect(message).not.toContain('2015550100');
  });
});
