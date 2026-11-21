import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../notifications/channels/http-transport';
import type { AuthMessenger } from './auth-messenger';
import { FakePhoneVerifier, TwilioVerifyPhoneVerifier } from './phone-verification';

/**
 * Phone verification providers (API-100-53 AC1/AC3/AC4): the fake (6 digits, 600 s, single use,
 * texted through the SMS adapter) and Twilio Verify against a FAKE transport (no network).
 */
class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];
  constructor(private readonly answer: (request: HttpRequest) => HttpResponse | Error) {}
  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const answer = this.answer(request);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
}

const reply = (status: number, body: unknown = {}): HttpResponse => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});

function fakeMessenger(sent: { to: string; text: string }[], ok = true): AuthMessenger {
  return {
    sms: (to: string, text: string) => {
      sent.push({ to, text });
      return Promise.resolve(ok);
    },
  } as unknown as AuthMessenger;
}

describe('FakePhoneVerifier', () => {
  it('texts a 6-digit code valid 600 s; right code once, wrong code, then expired', async () => {
    let now = 1_000_000;
    const sent: { to: string; text: string }[] = [];
    const verifier = new FakePhoneVerifier(fakeMessenger(sent), () => now);
    await expect(verifier.start('+447700900001')).resolves.toBe('sent');
    const code = /(\d{6})/.exec(sent[0].text)![1];
    expect(sent[0].to).toBe('+447700900001');
    const wrong = code === '000000' ? '000001' : '000000';
    await expect(verifier.check('+447700900001', wrong)).resolves.toBe('wrong');
    await expect(verifier.check('+447700900001', code)).resolves.toBe('approved');
    await expect(verifier.check('+447700900001', code)).resolves.toBe('expired');
    await verifier.start('+447700900001');
    const second = /(\d{6})/.exec(sent[1].text)![1];
    now += 600_000;
    await expect(verifier.check('+447700900001', second)).resolves.toBe('expired');
  });

  it('a failed text is "unavailable" and leaves no code', async () => {
    const verifier = new FakePhoneVerifier(fakeMessenger([], false));
    await expect(verifier.start('+447700900002')).resolves.toBe('unavailable');
    await expect(verifier.check('+447700900002', '123456')).resolves.toBe('expired');
  });
});

describe('TwilioVerifyPhoneVerifier (fake transport only)', () => {
  const credentials = {
    accountSid: 'ACfake',
    authToken: ['fake', 'auth', 'value'].join('-'),
    serviceSid: `VA${'0'.repeat(32)}`,
  };

  it('starts a verification: POST Verifications with To and Channel=sms, basic auth', async () => {
    const transport = new FakeTransport(() => reply(201, { sid: 'VEfake', status: 'pending' }));
    const verifier = new TwilioVerifyPhoneVerifier(credentials, transport);
    await expect(verifier.start('+447700900003')).resolves.toBe('sent');
    const [request] = transport.requests;
    expect(request.url).toBe(
      `https://verify.twilio.com/v2/Services/${credentials.serviceSid}/Verifications`,
    );
    expect(new URLSearchParams(request.body).get('To')).toBe('+447700900003');
    expect(new URLSearchParams(request.body).get('Channel')).toBe('sms');
    expect(request.headers.authorization.startsWith('Basic ')).toBe(true);
  });

  it.each<[HttpResponse | Error, string]>([
    [reply(200, { status: 'approved' }), 'approved'],
    [reply(200, { status: 'pending' }), 'wrong'],
    [reply(200, { status: 'canceled' }), 'expired'],
    [reply(404, { code: 20404 }), 'expired'],
    [reply(429, { code: 20429 }), 'unavailable'],
    [new Error('socket hang up'), 'unavailable'],
  ])('checks: %j → %s', async (answer, expected) => {
    const transport = new FakeTransport(() => answer);
    const verifier = new TwilioVerifyPhoneVerifier(credentials, transport);
    await expect(verifier.check('+447700900003', '123456')).resolves.toBe(expected);
    expect(transport.requests[0].url.endsWith('/VerificationCheck')).toBe(true);
  });

  it('a refused or failed start is "unavailable"', async () => {
    for (const answer of [reply(400, {}), new Error('timeout')]) {
      const verifier = new TwilioVerifyPhoneVerifier(credentials, new FakeTransport(() => answer));
      await expect(verifier.start('+447700900003')).resolves.toBe('unavailable');
    }
  });
});
