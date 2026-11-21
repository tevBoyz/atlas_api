import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import {
  authFakePhone,
  createAuthApp,
  DEVICE,
  errorOf,
  latestCode,
  mailbox,
  post,
  type SessionBody,
  signedUpUser,
} from '../support/auth-api';
import { openTestClient } from '../support/database';

/**
 * Stage 7.1c, A18 `PUT /v1/me/phone` + `POST /v1/me/phone/verify` (D39): a code to the NEW number
 * through the PhoneVerifier (the fake here), the limits of API-100-53, the number confirmed only
 * after the code; a number of another account answers the same and gets no code (D28, D29).
 */
describe('change phone (A18, stage 7.1c)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createAuthApp());
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const bearer = (session: SessionBody) => ({ authorization: `Bearer ${session.access_token}` });
  const send = (method: 'PUT' | 'POST', url: string, session: SessionBody | null, body: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...(session ? bearer(session) : {}), 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const start = (session: SessionBody | null, phone: unknown) =>
    send('PUT', '/v1/me/phone', session, { phone });
  const verify = (session: SessionBody, phone: string, code: string) =>
    send('POST', '/v1/me/phone/verify', session, { phone, code });
  const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  async function phoneOf(userId: string) {
    const { rows } = await client.query<{ phone: string | null; confirmed: boolean }>(
      'select phone, phone_confirmed_at is not null as confirmed from public.users where id = $1',
      [userId],
    );
    return rows[0];
  }

  it('401 without a token; 422 auth:invalid_phone for a number that is not strict +E.164', async () => {
    const anonymous = await start(null, authFakePhone());
    expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([
      401,
      'auth:not_authenticated',
    ]);
    const { session } = await signedUpUser(app);
    for (const phone of ['12', 'abc', null]) {
      const res = await start(session, phone);
      expect([res.statusCode, errorOf(res).code, errorOf(res).details.field]).toEqual([
        422,
        'auth:invalid_phone',
        'phone',
      ]);
    }
  });

  it('202 a code to the new number; the phone changes only after the right code; audit; OTP sign-in on the new number', async () => {
    const { session, phone: oldPhone } = await signedUpUser(app);
    const newPhone = authFakePhone();
    const res = await start(session, newPhone);
    expect([res.statusCode, res.json()]).toEqual([
      202,
      { verification: { channel: 'phone', expires_in_seconds: 600, resends_remaining: 3 } },
    ]);
    const code = latestCode(app, newPhone)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(await phoneOf(session.user.id)).toEqual({ phone: oldPhone, confirmed: false });

    // Not the pending number → 422; a wrong code → 400 with attempts left; nothing changes.
    const other = await verify(session, authFakePhone(), code);
    expect([other.statusCode, errorOf(other).code]).toEqual([422, 'auth:invalid_phone']);
    const wrong = await verify(session, newPhone, wrongCode(code));
    expect([
      wrong.statusCode,
      errorOf(wrong).code,
      errorOf(wrong).details.attempts_remaining,
    ]).toEqual([400, 'auth:otp_invalid', 4]);
    expect((await phoneOf(session.user.id)).phone).toBe(oldPhone);

    const ok = await verify(session, newPhone, code);
    expect(ok.statusCode).toBe(200);
    const user = ok.json<{
      user: {
        phone: string;
        phone_confirmed_at: string | null;
        identities: { provider: string }[];
      };
    }>().user;
    expect(user.phone).toBe(newPhone);
    expect(user.phone_confirmed_at).not.toBeNull();
    expect(user.identities.map((i) => i.provider).sort()).toEqual(['email', 'phone']);
    expect(await phoneOf(session.user.id)).toEqual({ phone: newPhone, confirmed: true });
    // The code is used up; the pending change is gone.
    const reuse = await verify(session, newPhone, code);
    expect([reuse.statusCode, errorOf(reuse).code]).toEqual([422, 'auth:invalid_phone']);

    const { rows: audit } = await client.query<{ detail: Record<string, unknown> }>(
      `select detail from public.audit_log where action = 'auth.phone.changed' and target_id = $1`,
      [session.user.id],
    );
    expect(audit).toEqual([{ detail: { had_number: true, same_number: false } }]);
    expect(JSON.stringify(audit)).not.toContain(newPhone.slice(1));

    // Phone sign-in now goes to the new number; the old one belongs to nobody.
    expect(
      (await post(app, '/v1/auth/otp/send', { phone: newPhone, purpose: 'sign_in' })).statusCode,
    ).toBe(202);
    const signIn = await post(app, '/v1/auth/otp/verify', {
      phone: newPhone,
      code: latestCode(app, newPhone),
      purpose: 'sign_in',
      device: DEVICE,
    });
    expect([signIn.statusCode, signIn.json<SessionBody>().user.id]).toEqual([200, session.user.id]);
    const before = mailbox(app, oldPhone).length;
    await post(app, '/v1/auth/otp/send', { phone: oldPhone, purpose: 'sign_in' });
    expect(mailbox(app, oldPhone)).toHaveLength(before);
  });

  it("another account's number: the same 202, no code, and no code verifies (no enumeration)", async () => {
    const holder = await signedUpUser(app);
    const { session } = await signedUpUser(app);
    const before = mailbox(app, holder.phone).length;
    const res = await start(session, holder.phone);
    expect([res.statusCode, res.json()]).toEqual([
      202,
      { verification: { channel: 'phone', expires_in_seconds: 600, resends_remaining: 3 } },
    ]);
    expect(mailbox(app, holder.phone)).toHaveLength(before);
    const guess = await verify(session, holder.phone, '123456');
    expect([guess.statusCode, errorOf(guess).code]).toEqual([400, 'auth:otp_invalid']);
    expect((await phoneOf(holder.session.user.id)).phone).toBe(holder.phone);
    expect((await phoneOf(session.user.id)).phone).not.toBe(holder.phone);
  });

  it('limits of API-100-53: 4 codes per number per 15 minutes; 5 wrong codes invalidate; a resend resets', async () => {
    const { session } = await signedUpUser(app);
    const phone = authFakePhone();
    const remaining: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      remaining.push(
        (await start(session, phone)).json<{ verification: { resends_remaining: number } }>()
          .verification.resends_remaining,
      );
    }
    expect(remaining).toEqual([3, 2, 1]);
    const code = latestCode(app, phone)!;
    const attempts: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await verify(session, phone, wrongCode(code));
      attempts.push(`${res.statusCode}:${errorOf(res).code}`);
    }
    expect(attempts).toEqual([
      ...Array<string>(4).fill('400:auth:otp_invalid'),
      '423:auth:otp_invalidated',
    ]);
    expect((await verify(session, phone, code)).statusCode).toBe(423);
    // The 4th code (a resend) resets the attempts; the 5th request is refused.
    expect(
      (await start(session, phone)).json<{ verification: { resends_remaining: number } }>()
        .verification.resends_remaining,
    ).toBe(0);
    const over = await start(session, phone);
    expect([over.statusCode, errorOf(over).code]).toEqual([429, 'auth:otp_resend_limit']);
    expect((await verify(session, phone, latestCode(app, phone)!)).statusCode).toBe(200);
  });

  it('503 auth:sms_unavailable when the SMS channel is off', async () => {
    const { app: off } = await createAuthApp({ CHANNEL_SMS_ENABLED: 'false' });
    try {
      const { session } = await signedUpUser(off);
      const res = await off.inject({
        method: 'PUT',
        url: '/v1/me/phone',
        headers: { ...bearer(session), 'content-type': 'application/json' },
        payload: JSON.stringify({ phone: authFakePhone() }),
      });
      expect([res.statusCode, errorOf(res).code]).toEqual([503, 'auth:sms_unavailable']);
    } finally {
      await off.close();
    }
  });
});
