import { generateKeyPairSync } from 'node:crypto';

import { decodeJwt, decodeProtectedHeader } from 'jose';
import type { Logger } from 'pino';

import type { ApiConfigService, ConfigKey } from '../../../config';
import { parseConfig } from '../../../config';
import { ChannelSenders } from './channel-senders';
import { isPermanentFailure, type PushMessage, type TestAlertPushMessage } from './channel.types';
import {
  FAKE_FAIL_TOKEN_PREFIX,
  FAKE_UNREGISTERED_TOKEN_PREFIX,
  FakeEmailSender,
  FakePushSender,
  FakeSmsSender,
} from './fake-senders';
import type { HttpRequest, HttpResponse, HttpTransport } from './http-transport';
import {
  ALERT_TTL_SECONDS,
  ANDROID_CHANNEL_ID,
  ANDROID_TEST_CHANNEL_ID,
  pushData,
  pushMessageOf,
  pushText,
  pushTime,
  pushTtlSeconds,
  shortenUpdateText,
} from './push-content';
import {
  ApnsPushSender,
  apnsAps,
  FcmPushSender,
  fcmMessage,
  pemFromEnv,
  RoutingPushSender,
  SendGridEmailSender,
  sendGridBody,
  TwilioSmsSender,
} from './real-senders';

/** Fake keys generated per run; fake tokens. Nothing here can reach a provider. */
const RSA_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const EC_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const DEVICE_TOKEN = 'fake-device-token-0123456789abcdef';
const SECRET_MARKER = 'SECRET-SHOULD-NEVER-APPEAR';

const MESSAGE: PushMessage = {
  topic: 'incident.created',
  incident_id: '11111111-1111-4111-8111-111111111111',
  emergency_type: 'medical',
  resident_name: 'Ada Example',
  occurred_at: '2026-11-20T10:00:00.000000+00:00',
};

/** Records requests; answers from a queue (default 200 `{}`). */
class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly answers: (HttpResponse | Error)[] = [];

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const next = this.answers.shift() ?? { status: 200, headers: {}, body: '{}' };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }

  answer(status: number, body: unknown = {}, headers: Record<string, string> = {}): this {
    this.answers.push({ status, headers, body: JSON.stringify(body) });
    return this;
  }
}

const logger = { info: jest.fn(), warn: jest.fn() } as unknown as Logger;

function sendersWith(env: Record<string, string>): ChannelSenders {
  const config = parseConfig(env);
  const service = { get: (key: ConfigKey) => config[key] } as unknown as ApiConfigService;
  return new ChannelSenders(service, logger);
}

describe('push content (API-100-46 AC3)', () => {
  it('copies only incident id, emergency type, resident name and time (plus the topic)', () => {
    const message = pushMessageOf('incident.created', {
      incident_id: MESSAGE.incident_id,
      emergency_type: 'medical',
      resident_name: 'Ada Example',
      occurred_at: MESSAGE.occurred_at,
      recipient_user_ids: ['x'],
      share_payload: { blood_type: 'O+' },
      allergies: 'peanuts',
      location_lat: 13.4,
      incident_notes: 'note',
    });
    expect(message).toEqual(MESSAGE);
    expect(Object.keys(pushData(message!)).sort()).toEqual([
      'emergency_type',
      'incident_id',
      'occurred_at',
      'resident_name',
      'topic',
    ]);
  });

  it('no incident id: no message', () => {
    expect(pushMessageOf('incident.created', { emergency_type: 'fire' })).toBeUndefined();
  });

  it('visible text uses the allowed values only, with the time (D54)', () => {
    expect(pushText(MESSAGE)).toEqual({
      title: 'Ada Example',
      body: 'Emergency alert: Medical · 10:00 AM',
    });
    expect(pushText({ ...MESSAGE, topic: 'incident.renotified', resident_name: null })).toEqual({
      title: 'Atlas',
      body: 'Alert sent again: Medical · 10:00 AM',
    });
    expect(pushText({ ...MESSAGE, topic: 'incident.resolved' }).body).toBe(
      'Marked safe. The alert is closed. · 10:00 AM',
    );
    expect(pushText({ ...MESSAGE, occurred_at: null }).body).toBe('Emergency alert: Medical');
  });

  it('D54: the time is in the recipient time zone, 12-hour h:mm AM/PM (gap 62); default Africa/Banjul', () => {
    const at = '2026-11-20T22:05:00.123456+00:00';
    // Two recipients of the same alert in different zones see their own local time.
    expect(pushText({ ...MESSAGE, occurred_at: at }, 'America/Chicago').body).toBe(
      'Emergency alert: Medical · 4:05 PM',
    );
    expect(pushText({ ...MESSAGE, occurred_at: at }, 'Asia/Kolkata').body).toBe(
      'Emergency alert: Medical · 3:35 AM',
    );
    expect(pushTime(at, 'Africa/Banjul')).toBe('10:05 PM');
    expect(pushTime(at, null)).toBe('10:05 PM');
    expect(pushTime(at, 'Not/AZone')).toBe('10:05 PM');
  });

  it('gap 62: 12-hour form: no leading zero, midnight 12:xx AM, noon 12:xx PM, plain space', () => {
    expect(pushTime('2026-11-20T00:00:00Z', 'Africa/Banjul')).toBe('12:00 AM');
    expect(pushTime('2026-11-20T00:07:00Z', 'Africa/Banjul')).toBe('12:07 AM');
    expect(pushTime('2026-11-20T12:00:00Z', 'Africa/Banjul')).toBe('12:00 PM');
    expect(pushTime('2026-11-20T12:59:59Z', 'Africa/Banjul')).toBe('12:59 PM');
    expect(pushTime('2026-11-20T07:05:00Z', 'Africa/Banjul')).toBe('7:05 AM');
    expect(pushTime('2026-11-20T19:20:00Z', 'Africa/Banjul')).toBe('7:20 PM');
    expect(pushTime('2026-11-20T01:00:00Z', 'Africa/Banjul')).toBe('1:00 AM');
    expect(pushTime('2026-11-20T11:59:00Z', 'Africa/Banjul')).toBe('11:59 AM');
    expect(pushTime('2026-11-20T23:59:00Z', 'Africa/Banjul')).toBe('11:59 PM');
    // A zone where the local day is different: Tokyo is UTC+9.
    expect(pushTime('2026-11-20T15:30:00Z', 'Asia/Tokyo')).toBe('12:30 AM');
    // The space before AM / PM is a plain U+0020 (never ICU's narrow no-break space).
    expect(pushTime('2026-11-20T19:20:00Z', 'Africa/Banjul')).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    expect(pushTime('not a time', 'Africa/Banjul')).toBeNull();
    expect(pushTime(null, 'Africa/Banjul')).toBeNull();
  });

  it('D55: alerts live 60 s, the closing notice 1 h', () => {
    expect(pushTtlSeconds('incident.created')).toBe(ALERT_TTL_SECONDS);
    expect(pushTtlSeconds('incident.renotified')).toBe(60);
    expect(pushTtlSeconds('incident.resolved')).toBe(3600);
  });
});

describe('D55: provider message shape', () => {
  const NOW = Date.parse('2026-11-20T10:00:01Z');

  it('FCM: emergency channel, high / max priority, default sound, TTL, five data keys, no click_action', () => {
    const target = { provider: 'fcm' as const, token: DEVICE_TOKEN, time_zone: 'Africa/Banjul' };
    expect(fcmMessage(target, MESSAGE, NOW)).toEqual({
      token: DEVICE_TOKEN,
      notification: { title: 'Ada Example', body: 'Emergency alert: Medical · 10:00 AM' },
      data: pushData(MESSAGE),
      android: {
        priority: 'high',
        ttl: '60s',
        notification: {
          channel_id: ANDROID_CHANNEL_ID,
          notification_priority: 'PRIORITY_MAX',
          sound: 'default',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
          'apns-expiration': String(Math.floor(NOW / 1000) + 60),
        },
        payload: {
          aps: {
            alert: { title: 'Ada Example', body: 'Emergency alert: Medical · 10:00 AM' },
            sound: 'default',
            'interruption-level': 'time-sensitive',
          },
        },
      },
    });
    expect(ANDROID_CHANNEL_ID).toBe('atlas_emergency');
  });

  it('FCM: the closing notice keeps the channel, lives 1 h; APNs level active', () => {
    const resolved = { ...MESSAGE, topic: 'incident.resolved' };
    const body = fcmMessage({ provider: 'fcm', token: DEVICE_TOKEN }, resolved, NOW) as {
      android: { ttl: string; notification: { channel_id: string } };
      apns: { headers: Record<string, string> };
    };
    expect(body.android.ttl).toBe('3600s');
    expect(body.android.notification.channel_id).toBe('atlas_emergency');
    expect(body.apns.headers['apns-expiration']).toBe(String(Math.floor(NOW / 1000) + 3600));
    expect(apnsAps({ provider: 'apns', token: DEVICE_TOKEN }, resolved)).toMatchObject({
      'interruption-level': 'active',
    });
  });

  it('the recipient time zone never travels as a value of its own', () => {
    const target = { provider: 'fcm' as const, token: DEVICE_TOKEN, time_zone: 'Asia/Tokyo' };
    const text = JSON.stringify(fcmMessage(target, MESSAGE, NOW));
    expect(text).not.toContain('Asia/Tokyo');
    expect(text).toContain('Emergency alert: Medical · 7:00 PM');
  });
});

describe('SCRUM-35 (D67): test alert notices', () => {
  const NOW = Date.parse('2026-11-24T16:48:00Z');
  const TEST: TestAlertPushMessage = {
    topic: 'circle.test_alert',
    test_alert_id: '22222222-2222-4222-8222-222222222222',
    owner_name: 'Rita Owner',
    occurred_at: '2026-11-24T16:48:05.123456+00:00',
  };

  it('copies only the test alert id, the owner name and the time; never an incident id', () => {
    const message = pushMessageOf('circle.test_alert', {
      test_alert_id: TEST.test_alert_id,
      circle_id: '33333333-3333-4333-8333-333333333333',
      owner_name: 'Rita Owner',
      occurred_at: TEST.occurred_at,
      recipient_user_ids: ['x'],
      incident_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(message).toEqual(TEST);
    expect(pushData(message!)).toEqual({
      topic: 'circle.test_alert',
      test_alert_id: TEST.test_alert_id,
      owner_name: 'Rita Owner',
    });
    expect(pushMessageOf('circle.test_alert', { owner_name: 'x' })).toBeUndefined();
  });

  it('title TEST ALERT — NOT AN EMERGENCY; body names the owner, with the time in the recipient zone', () => {
    expect(pushText(TEST)).toEqual({
      title: 'TEST ALERT — NOT AN EMERGENCY',
      body: 'Rita Owner is testing their Safety Circle · 4:48 PM',
    });
    expect(pushText(TEST, 'America/Chicago').body).toBe(
      'Rita Owner is testing their Safety Circle · 10:48 AM',
    );
    expect(pushText({ ...TEST, owner_name: null, occurred_at: null })).toEqual({
      title: 'TEST ALERT — NOT AN EMERGENCY',
      body: 'Your Safety Circle owner is testing their Safety Circle',
    });
  });

  it('FCM: the atlas_test channel, default notification priority, 1 h TTL; APNs passive, no sound', () => {
    const target = { provider: 'fcm' as const, token: DEVICE_TOKEN, time_zone: 'Africa/Banjul' };
    expect(fcmMessage(target, TEST, NOW)).toEqual({
      token: DEVICE_TOKEN,
      notification: {
        title: 'TEST ALERT — NOT AN EMERGENCY',
        body: 'Rita Owner is testing their Safety Circle · 4:48 PM',
      },
      data: pushData(TEST),
      android: {
        priority: 'high',
        ttl: '3600s',
        notification: {
          channel_id: 'atlas_test',
          notification_priority: 'PRIORITY_DEFAULT',
          sound: 'default',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
          'apns-expiration': String(Math.floor(NOW / 1000) + 3600),
        },
        payload: {
          aps: {
            alert: pushText(TEST, 'Africa/Banjul'),
            'interruption-level': 'passive',
          },
        },
      },
    });
    expect(ANDROID_TEST_CHANNEL_ID).toBe('atlas_test');
    expect(pushTtlSeconds('circle.test_alert')).toBe(3600);
  });

  it('the fake push keeps the test text (for tests and the guide)', async () => {
    const fake = new FakePushSender();
    await fake.send({ provider: 'fcm', token: DEVICE_TOKEN, time_zone: 'Africa/Banjul' }, TEST);
    expect(fake.sent[0].text).toEqual({
      title: 'TEST ALERT — NOT AN EMERGENCY',
      body: 'Rita Owner is testing their Safety Circle · 4:48 PM',
    });
    expect(fake.sent[0].content).toEqual(TEST);
  });
});

describe('fake adapters (AC2)', () => {
  it('push: sent with a fake id; fail and unregistered prefixes for the failure paths', async () => {
    const fake = new FakePushSender();
    const ok = await fake.send({ provider: 'fcm', token: DEVICE_TOKEN }, MESSAGE);
    expect(ok.status).toBe('sent');
    expect(ok.provider_message_id).toMatch(/^fake-/);
    expect(
      await fake.send({ provider: 'fcm', token: `${FAKE_FAIL_TOKEN_PREFIX}1` }, MESSAGE),
    ).toEqual({ provider_message_id: null, status: 'failed', error_code: 'fake_unavailable' });
    expect(
      await fake.send({ provider: 'apns', token: `${FAKE_UNREGISTERED_TOKEN_PREFIX}1` }, MESSAGE),
    ).toEqual({ provider_message_id: null, status: 'failed', error_code: 'unregistered' });
    expect(fake.calls).toHaveLength(3);
    expect(fake.sent).toHaveLength(1);
    // The fake keeps the visible text the real adapters would send (D54), for tests and the guide.
    expect(fake.sent[0].text).toEqual(pushText(MESSAGE));
    await fake.send(
      { provider: 'fcm', token: DEVICE_TOKEN, time_zone: 'America/Chicago' },
      MESSAGE,
    );
    expect(fake.sent[1].text?.body).toBe('Emergency alert: Medical · 4:00 AM');
  });

  it('sms and email: sent, kept in memory only', async () => {
    const sms = new FakeSmsSender();
    const email = new FakeEmailSender();
    expect((await sms.send('+12015550123', 'hi')).status).toBe('sent');
    expect((await email.send('a@example.test', 's', 't')).status).toBe('sent');
    expect(sms.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it('permanent failures are not retried; transient ones are', () => {
    expect(isPermanentFailure('unregistered')).toBe(true);
    expect(isPermanentFailure('invalid_recipient')).toBe(true);
    expect(isPermanentFailure('fake_unavailable')).toBe(false);
    expect(isPermanentFailure('provider_unavailable')).toBe(false);
    expect(isPermanentFailure(undefined)).toBe(false);
  });
});

describe('ChannelSenders: which adapter, and whether it may send (AC2, AC4)', () => {
  it('defaults: every channel disabled, every adapter fake', () => {
    const senders = sendersWith({});
    expect(senders.isEnabled('push')).toBe(false);
    expect(senders.isEnabled('sms')).toBe(false);
    expect(senders.isEnabled('email')).toBe(false);
    expect(senders.push).toBeInstanceOf(FakePushSender);
    expect(senders.sms).toBeInstanceOf(FakeSmsSender);
    expect(senders.email).toBeInstanceOf(FakeEmailSender);
  });

  it('enabling a channel without a real adapter keeps the fake (tests, local manual runs)', () => {
    const senders = sendersWith({ CHANNEL_PUSH_ENABLED: 'true', CHANNEL_SMS_ENABLED: 'true' });
    expect(senders.isEnabled('push')).toBe(true);
    expect(senders.push).toBeInstanceOf(FakePushSender);
    expect(senders.sms).toBeInstanceOf(FakeSmsSender);
  });

  it('the real push adapter only with CHANNEL_PUSH_ADAPTER=real and keys (FCM only: APNs not configured)', async () => {
    const senders = sendersWith({
      CHANNEL_PUSH_ADAPTER: 'real',
      FCM_PROJECT_ID: 'fake-project',
      FCM_CLIENT_EMAIL: 'fake@example.test',
      FCM_PRIVATE_KEY: RSA_PEM,
    });
    expect(senders.push).toBeInstanceOf(RoutingPushSender);
    // No network: an APNs token has no adapter here.
    expect(await senders.push.send({ provider: 'apns', token: DEVICE_TOKEN }, MESSAGE)).toEqual({
      provider_message_id: null,
      status: 'failed',
      error_code: 'not_configured',
    });
  });

  it('Twilio cannot be built while the hold is on: the config refuses it', () => {
    expect(() =>
      sendersWith({
        CHANNEL_SMS_ADAPTER: 'twilio',
        TWILIO_ACCOUNT_SID: 'ACfake',
        TWILIO_AUTH_TOKEN: SECRET_MARKER,
        TWILIO_FROM_NUMBER: '+12015550100',
      }),
    ).toThrow('Twilio hold');
  });

  it('email: SendGrid only with CHANNEL_EMAIL_ADAPTER=sendgrid and its key and sender (D43)', () => {
    expect(sendersWith({ CHANNEL_EMAIL_ENABLED: 'true' }).email).toBeInstanceOf(FakeEmailSender);
    const senders = sendersWith({
      CHANNEL_EMAIL_ADAPTER: 'sendgrid',
      SENDGRID_API_KEY: SECRET_MARKER,
      EMAIL_FROM_ADDRESS: 'alerts@example.test',
    });
    expect(senders.email).toBeInstanceOf(SendGridEmailSender);
    expect(senders.isEnabled('email')).toBe(false);
    expect(() => sendersWith({ CHANNEL_EMAIL_ADAPTER: 'sendgrid' })).toThrow('SENDGRID_API_KEY');
  });
});

describe('FCM HTTP v1 adapter against a fake transport', () => {
  const credentials = {
    projectId: 'fake-project',
    clientEmail: 'fake@fake-project.example.test',
    privateKey: RSA_PEM.replace(/\n/g, '\\n'),
  };

  it('exchanges a signed service-account JWT once, then sends the five allowed values', async () => {
    const transport = new FakeTransport()
      .answer(200, { access_token: 'fake-access', expires_in: 3600 })
      .answer(200, { name: 'projects/fake-project/messages/1' })
      .answer(200, { name: 'projects/fake-project/messages/2' });
    const fcm = new FcmPushSender(credentials, transport);

    expect(await fcm.send({ provider: 'fcm', token: DEVICE_TOKEN }, MESSAGE)).toEqual({
      provider_message_id: 'projects/fake-project/messages/1',
      status: 'sent',
    });
    await fcm.send({ provider: 'fcm', token: DEVICE_TOKEN }, MESSAGE);

    const [oauth, send] = transport.requests;
    expect(transport.requests).toHaveLength(3);
    expect(oauth.url).toBe('https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(oauth.body).get('assertion')!;
    expect(decodeProtectedHeader(assertion).alg).toBe('RS256');
    expect(decodeJwt(assertion)).toMatchObject({
      iss: credentials.clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/fake-project/messages:send');
    expect(send.headers.authorization).toBe('Bearer fake-access');
    const body = JSON.parse(send.body) as { message: Record<string, unknown> };
    expect(body.message.token).toBe(DEVICE_TOKEN);
    expect(body.message.data).toEqual(pushData(MESSAGE));
    expect(body.message.notification).toEqual(pushText(MESSAGE));
    // D55: the whole message comes from the builder (checked field by field in its own test).
    expect(Object.keys(body.message).sort()).toEqual([
      'android',
      'apns',
      'data',
      'notification',
      'token',
    ]);
    expect(body.message.android).toMatchObject({
      priority: 'high',
      ttl: '60s',
      notification: { channel_id: 'atlas_emergency', notification_priority: 'PRIORITY_MAX' },
    });
  });

  it.each([
    [
      404,
      { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
      'unregistered',
    ],
    [403, { error: { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } }, 'unregistered'],
    [400, { error: { details: [{ errorCode: 'INVALID_ARGUMENT' }] } }, 'invalid_request'],
    [429, { error: { details: [{ errorCode: 'QUOTA_EXCEEDED' }] } }, 'rate_limited'],
    [503, { error: { details: [{ errorCode: 'UNAVAILABLE' }] } }, 'provider_unavailable'],
    [401, { error: { status: 'UNAUTHENTICATED' } }, 'auth_failed'],
  ])('HTTP %i → %s', async (status, body, code) => {
    const transport = new FakeTransport()
      .answer(200, { access_token: 'fake-access', expires_in: 3600 })
      .answer(status, body);
    const result = await new FcmPushSender(credentials, transport).send(
      { provider: 'fcm', token: DEVICE_TOKEN },
      MESSAGE,
    );
    expect(result).toEqual({ provider_message_id: null, status: 'failed', error_code: code });
  });

  it('a refused OAuth exchange is auth_failed; a network error transport_error; nothing secret in results', async () => {
    const refused = new FakeTransport().answer(400, { error: 'invalid_grant' });
    const one = await new FcmPushSender(credentials, refused).send(
      { provider: 'fcm', token: DEVICE_TOKEN },
      MESSAGE,
    );
    expect(one.error_code).toBe('auth_failed');
    const down = new FakeTransport();
    down.answers.push({ status: 200, headers: {}, body: '{"access_token":"a","expires_in":60}' });
    down.answers.push(new Error(`connect ECONNREFUSED ${DEVICE_TOKEN}`));
    const two = await new FcmPushSender(credentials, down).send(
      { provider: 'fcm', token: DEVICE_TOKEN },
      MESSAGE,
    );
    expect(two.error_code).toBe('transport_error');
    expect(JSON.stringify([one, two])).not.toContain(DEVICE_TOKEN);
  });
});

describe('APNs adapter against a fake transport', () => {
  const credentials = {
    keyId: 'FAKEKEY123',
    teamId: 'FAKETEAM12',
    privateKey: EC_PEM,
    bundleId: 'test.example.atlas',
    environment: 'sandbox' as const,
  };

  it('signs an ES256 provider token and posts the alert with the five values', async () => {
    const transport = new FakeTransport().answer(200, {}, { 'apns-id': 'apns-1' });
    const result = await new ApnsPushSender(credentials, transport).send(
      { provider: 'apns', token: DEVICE_TOKEN },
      MESSAGE,
    );
    expect(result).toEqual({ provider_message_id: 'apns-1', status: 'sent' });
    const [request] = transport.requests;
    expect(request.url).toBe(`https://api.sandbox.push.apple.com/3/device/${DEVICE_TOKEN}`);
    expect(request.headers['apns-topic']).toBe('test.example.atlas');
    const jwt = request.headers.authorization.replace(/^bearer /, '');
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: 'ES256', kid: 'FAKEKEY123' });
    expect(decodeJwt(jwt).iss).toBe('FAKETEAM12');
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toEqual({
      aps: { alert: pushText(MESSAGE), sound: 'default', 'interruption-level': 'time-sensitive' },
      ...pushData(MESSAGE),
    });
    expect(request.headers['apns-priority']).toBe('10');
    expect(request.headers['apns-push-type']).toBe('alert');
    expect(Number(request.headers['apns-expiration'])).toBeGreaterThan(Date.now() / 1000);
  });

  it('D55/D54: time-sensitive alert with the time in the recipient zone; the closing notice active', async () => {
    const transport = new FakeTransport()
      .answer(200, {}, { 'apns-id': 'apns-2' })
      .answer(200, {}, { 'apns-id': 'apns-3' });
    const now = Date.parse('2026-11-20T10:00:00Z');
    const sender = new ApnsPushSender(credentials, transport, () => now);
    const target = { provider: 'apns' as const, token: DEVICE_TOKEN, time_zone: 'Asia/Tokyo' };
    await sender.send(target, MESSAGE);
    await sender.send(target, { ...MESSAGE, topic: 'incident.resolved' });
    const [alert, closed] = transport.requests.map(
      (r) => JSON.parse(r.body) as { aps: Record<string, unknown> },
    );
    expect(alert.aps).toEqual({
      alert: { title: 'Ada Example', body: 'Emergency alert: Medical · 7:00 PM' },
      sound: 'default',
      'interruption-level': 'time-sensitive',
    });
    expect(closed.aps['interruption-level']).toBe('active');
    expect(transport.requests[0].headers['apns-expiration']).toBe(String(now / 1000 + 60));
    expect(transport.requests[1].headers['apns-expiration']).toBe(String(now / 1000 + 3600));
    expect(JSON.stringify(alert)).not.toContain('Asia/Tokyo');
  });

  it.each([
    [410, { reason: 'Unregistered' }, 'unregistered'],
    [400, { reason: 'BadDeviceToken' }, 'unregistered'],
    [400, { reason: 'DeviceTokenNotForTopic' }, 'unregistered'],
    [400, { reason: 'PayloadTooLarge' }, 'invalid_request'],
    [403, { reason: 'ExpiredProviderToken' }, 'auth_failed'],
    [429, { reason: 'TooManyRequests' }, 'rate_limited'],
    [503, { reason: 'ServiceUnavailable' }, 'provider_unavailable'],
  ])('HTTP %i %o → %s', async (status, body, code) => {
    const transport = new FakeTransport().answer(status, body);
    const result = await new ApnsPushSender(credentials, transport).send(
      { provider: 'apns', token: DEVICE_TOKEN },
      MESSAGE,
    );
    expect(result.error_code).toBe(code);
  });

  it('a timeout is a retryable failure', async () => {
    const transport = new FakeTransport();
    transport.answers.push(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    const result = await new ApnsPushSender(credentials, transport).send(
      { provider: 'apns', token: DEVICE_TOKEN },
      MESSAGE,
    );
    expect(result.error_code).toBe('timeout');
    expect(isPermanentFailure(result.error_code)).toBe(false);
  });
});

describe('Twilio adapter against a fake transport (never built during the hold)', () => {
  const credentials = { accountSid: 'ACfake', authToken: SECRET_MARKER, from: '+12015550100' };

  it('posts To/From/Body with basic auth and returns the sid', async () => {
    const transport = new FakeTransport().answer(201, { sid: 'SMfake' });
    const result = await new TwilioSmsSender(credentials, transport).send('+12015550123', 'hello');
    expect(result).toEqual({ provider_message_id: 'SMfake', status: 'sent' });
    const [request] = transport.requests;
    expect(request.url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages.json');
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      To: '+12015550123',
      From: '+12015550100',
      Body: 'hello',
    });
    expect(request.headers.authorization).toMatch(/^Basic /);
  });

  it.each([
    [400, { code: 21211 }, 'invalid_recipient'],
    [400, { code: 21614 }, 'invalid_recipient'],
    [400, { code: 21602 }, 'invalid_request'],
    [401, { code: 20003 }, 'auth_failed'],
    [429, { code: 20429 }, 'rate_limited'],
    [500, {}, 'provider_unavailable'],
  ])('HTTP %i %o → %s, without the auth token', async (status, body, code) => {
    const transport = new FakeTransport().answer(status, body);
    const result = await new TwilioSmsSender(credentials, transport).send('+12015550123', 'x');
    expect(result.error_code).toBe(code);
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
  });
});

describe('SendGrid email adapter against a fake transport (D43)', () => {
  const settings = {
    apiKey: SECRET_MARKER,
    baseUrl: 'https://api.sendgrid.com',
    fromAddress: 'alerts@example.test',
    fromName: 'Atlas',
  };
  const TO = 'member@example.test';
  const TEXT = 'Open this link: io.supabase.atlasmobile://login-callback/?type=signup&token=abc';

  it('posts one plain-text message with the Bearer key, tracking off; 202 -> sent with X-Message-Id', async () => {
    const transport = new FakeTransport();
    transport.answers.push({ status: 202, headers: { 'x-message-id': 'sg-msg-1' }, body: '' });
    const result = await new SendGridEmailSender(settings, transport).send(TO, 'Subject', TEXT);
    expect(result).toEqual({ provider_message_id: 'sg-msg-1', status: 'sent' });
    const [request] = transport.requests;
    expect(request).toMatchObject({
      method: 'POST',
      url: 'https://api.sendgrid.com/v3/mail/send',
      headers: { authorization: `Bearer ${SECRET_MARKER}`, 'content-type': 'application/json' },
    });
    expect(JSON.parse(request.body)).toEqual({
      personalizations: [{ to: [{ email: TO }] }],
      from: { email: 'alerts@example.test', name: 'Atlas' },
      subject: 'Subject',
      content: [{ type: 'text/plain', value: TEXT }],
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
      },
    });
  });

  it('no from name: from has the address only; a base URL with a trailing slash still works', async () => {
    expect(sendGridBody({ fromAddress: 'a@example.test' }, TO, 's', 't').from).toEqual({
      email: 'a@example.test',
    });
    const transport = new FakeTransport();
    transport.answers.push({ status: 202, headers: {}, body: '' });
    const result = await new SendGridEmailSender(
      { ...settings, baseUrl: 'http://127.0.0.1:9999/' },
      transport,
    ).send(TO, 's', 't');
    expect(transport.requests[0].url).toBe('http://127.0.0.1:9999/v3/mail/send');
    expect(result).toEqual({ provider_message_id: null, status: 'sent' });
  });

  it.each([
    [
      400,
      { errors: [{ field: 'personalizations.0.to.0.email', message: 'invalid' }] },
      'invalid_recipient',
      true,
    ],
    [400, { errors: [{ field: 'from.email', message: 'not verified' }] }, 'invalid_request', true],
    [400, 'not json', 'invalid_request', true],
    [413, {}, 'invalid_request', true],
    [401, { errors: [{ message: 'bad key' }] }, 'auth_failed', false],
    [403, {}, 'auth_failed', false],
    [429, {}, 'rate_limited', false],
    [500, {}, 'provider_unavailable', false],
    [503, {}, 'provider_unavailable', false],
  ])(
    'HTTP %i %o -> %s (permanent: %s), never the key, address or text',
    async (status, body, code, permanent) => {
      const transport = new FakeTransport().answer(status, body);
      const result = await new SendGridEmailSender(settings, transport).send(TO, 'Subject', TEXT);
      expect(result).toEqual({ provider_message_id: null, status: 'failed', error_code: code });
      expect(isPermanentFailure(result.error_code)).toBe(permanent);
      const serialized = JSON.stringify(result);
      for (const secret of [SECRET_MARKER, TO, 'token=abc'])
        expect(serialized).not.toContain(secret);
    },
  );

  it('a timeout and a network failure are retryable failures', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const transport = new FakeTransport();
    transport.answers.push(timeout, new Error('ECONNREFUSED'));
    const sender = new SendGridEmailSender(settings, transport);
    expect((await sender.send(TO, 's', 't')).error_code).toBe('timeout');
    expect((await sender.send(TO, 's', 't')).error_code).toBe('transport_error');
    expect(isPermanentFailure('timeout')).toBe(false);
    expect(isPermanentFailure('transport_error')).toBe(false);
  });
});

it('pemFromEnv turns literal \\n into newlines', () => {
  expect(pemFromEnv('a\\nb')).toBe('a\nb');
  expect(pemFromEnv('a\nb')).toBe('a\nb');
});

describe('SCRUM-44/59 (D70): status update notices', () => {
  const NOW = Date.parse('2026-11-24T16:48:00Z');
  const INCIDENT_ID = '11111111-1111-4111-8111-111111111111';
  const AT = '2026-11-24T16:48:05.123456+00:00';
  const PAYLOAD = {
    incident_id: INCIDENT_ID,
    resident_name: 'Tess Resident',
    occurred_at: AT,
    update_id: '44444444-4444-4444-8444-444444444444',
    recipient_user_ids: ['55555555-5555-4555-8555-555555555555'],
    emergency_type: 'medical',
  };

  it('copies the incident id, the resident name, the time and the preset (or the text) only', () => {
    expect(
      pushMessageOf('incident.status_update', {
        ...PAYLOAD,
        preset: 'situation_worsening',
        text: null,
      }),
    ).toEqual({
      topic: 'incident.status_update',
      incident_id: INCIDENT_ID,
      resident_name: 'Tess Resident',
      occurred_at: AT,
      preset: 'situation_worsening',
      text: null,
    });
    expect(
      pushMessageOf('incident.status_update', { ...PAYLOAD, preset: null, text: 'Door locked' }),
    ).toEqual({
      topic: 'incident.status_update',
      incident_id: INCIDENT_ID,
      resident_name: 'Tess Resident',
      occurred_at: AT,
      preset: null,
      text: 'Door locked',
    });
    // Neither a known preset nor text, or no incident: nothing to send.
    expect(
      pushMessageOf('incident.status_update', { ...PAYLOAD, preset: 'other' }),
    ).toBeUndefined();
    expect(pushMessageOf('incident.status_update', { ...PAYLOAD, text: '' })).toBeUndefined();
    expect(
      pushMessageOf('incident.status_update', { preset: 'help_is_here', occurred_at: AT }),
    ).toBeUndefined();
  });

  it('title = the resident name; body = the preset text or the text, plus h:mm AM/PM in the recipient zone', () => {
    const worsening = pushMessageOf('incident.status_update', {
      ...PAYLOAD,
      preset: 'situation_worsening',
    })!;
    const help = pushMessageOf('incident.status_update', { ...PAYLOAD, preset: 'help_is_here' })!;
    const text = pushMessageOf('incident.status_update', { ...PAYLOAD, text: 'Door locked' })!;
    expect(pushText(worsening)).toEqual({
      title: 'Tess Resident',
      body: 'Situation worsening · 4:48 PM',
    });
    expect(pushText(help, 'Africa/Banjul')).toEqual({
      title: 'Tess Resident',
      body: 'Help is here · 4:48 PM',
    });
    expect(pushText(text, 'America/Chicago')).toEqual({
      title: 'Tess Resident',
      body: 'Door locked · 10:48 AM',
    });
    // No name → Atlas; no time → no suffix (D54).
    expect(
      pushText(
        pushMessageOf('incident.status_update', {
          incident_id: INCIDENT_ID,
          preset: 'help_is_here',
        })!,
      ),
    ).toEqual({ title: 'Atlas', body: 'Help is here' });
  });

  it('a long text is one line of at most 100 characters ending with …', () => {
    expect(shortenUpdateText('Line one\n\n  line   two ')).toBe('Line one line two');
    expect(shortenUpdateText('a'.repeat(100))).toBe('a'.repeat(100));
    const long = `${'a'.repeat(98)} ${'b'.repeat(150)}`;
    expect(shortenUpdateText(long)).toBe(`${'a'.repeat(98)}…`);
    expect([...shortenUpdateText('🚑'.repeat(250))]).toHaveLength(100);
    expect(shortenUpdateText('🚑'.repeat(250))).toBe(`${'🚑'.repeat(99)}…`);
    const message = pushMessageOf('incident.status_update', { ...PAYLOAD, text: 'c'.repeat(250) })!;
    expect(pushText(message).body).toBe(`${'c'.repeat(99)}… · 4:48 PM`);
  });

  it('data keys are exactly topic and incident_id (never the text)', () => {
    const message = pushMessageOf('incident.status_update', { ...PAYLOAD, text: 'Door locked' })!;
    expect(pushData(message)).toEqual({
      topic: 'incident.status_update',
      incident_id: INCIDENT_ID,
    });
  });

  it('FCM: the emergency channel and priority of an alert (D55); APNs time-sensitive', () => {
    const message = pushMessageOf('incident.status_update', {
      ...PAYLOAD,
      preset: 'situation_worsening',
    })!;
    const target = { provider: 'fcm' as const, token: DEVICE_TOKEN, time_zone: 'Africa/Banjul' };
    expect(fcmMessage(target, message, NOW)).toEqual({
      token: DEVICE_TOKEN,
      notification: { title: 'Tess Resident', body: 'Situation worsening · 4:48 PM' },
      data: { topic: 'incident.status_update', incident_id: INCIDENT_ID },
      android: {
        priority: 'high',
        ttl: `${ALERT_TTL_SECONDS}s`,
        notification: {
          channel_id: ANDROID_CHANNEL_ID,
          notification_priority: 'PRIORITY_MAX',
          sound: 'default',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
          'apns-expiration': String(Math.floor(NOW / 1000) + ALERT_TTL_SECONDS),
        },
        payload: {
          aps: {
            alert: { title: 'Tess Resident', body: 'Situation worsening · 4:48 PM' },
            sound: 'default',
            'interruption-level': 'time-sensitive',
          },
        },
      },
    });
    expect(apnsAps(target, message)['interruption-level']).toBe('time-sensitive');
  });

  it('the fake push keeps the visible text (for tests and the guide)', async () => {
    const fake = new FakePushSender();
    const message = pushMessageOf('incident.status_update', { ...PAYLOAD, text: 'Door locked' })!;
    await fake.send({ provider: 'fcm', token: DEVICE_TOKEN, time_zone: 'Africa/Banjul' }, message);
    expect(fake.sent[0].text).toEqual({ title: 'Tess Resident', body: 'Door locked · 4:48 PM' });
  });
});

describe('SCRUM-71 (D73): the resident\'s "alert not delivered" notice', () => {
  const NOW = Date.parse('2026-11-20T10:00:01Z');
  const payload = {
    incident_id: 'i-1',
    member_name: 'Ned49 Test',
    reason: 'no_device',
    occurred_at: '2026-11-20T10:00:00+00:00',
    recipient_user_ids: ['r-1'],
  };

  it('message: the incident id and the member name only', () => {
    expect(pushMessageOf('incident.delivery_failed', payload)).toEqual({
      topic: 'incident.delivery_failed',
      incident_id: 'i-1',
      member_name: 'Ned49 Test',
    });
    expect(pushMessageOf('incident.delivery_failed', { member_name: 'x' })).toBeUndefined();
  });

  it('text: "Alert not delivered" / "<name> didn\'t receive your alert"; a blank name has a fallback', () => {
    const message = pushMessageOf('incident.delivery_failed', payload)!;
    expect(pushText(message, 'Asia/Tokyo')).toEqual({
      title: 'Alert not delivered',
      body: "Ned49 Test didn't receive your alert",
    });
    const blank = pushMessageOf('incident.delivery_failed', { ...payload, member_name: '' })!;
    expect(pushText(blank).body).toBe("A Safety Circle member didn't receive your alert");
  });

  it('data: exactly topic and incident_id; delivered like the closing notice (not an alert)', () => {
    const message = pushMessageOf('incident.delivery_failed', payload)!;
    expect(pushData(message)).toEqual({ topic: 'incident.delivery_failed', incident_id: 'i-1' });
    expect(pushTtlSeconds('incident.delivery_failed')).toBe(3600);
    const body = fcmMessage({ provider: 'fcm', token: DEVICE_TOKEN }, message, NOW) as {
      android: { ttl: string; notification: { channel_id: string } };
    };
    expect(body.android.ttl).toBe('3600s');
    expect(body.android.notification.channel_id).toBe(ANDROID_CHANNEL_ID);
    expect(apnsAps({ provider: 'apns', token: DEVICE_TOKEN }, message)).toMatchObject({
      'interruption-level': 'active',
    });
    expect(JSON.stringify(body)).not.toContain('r-1');
  });
});
