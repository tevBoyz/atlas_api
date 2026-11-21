import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import type { Client } from 'pg';

import { identifierKey } from '../../src/modules/auth/auth-limits';
import type { LogCapture } from '../../src/testing/test-app';
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
 * API-100-53: phone OTP with server-enforced limits (spec §6.9 rules 49-50 moved to the server):
 * 4 codes per number per sliding 15 minutes, 5 failed attempts invalidate the code until a resend,
 * a resend resets the count, 6 digits valid 600 s, the same answers for unknown numbers, the fake
 * SMS adapter, and codes never logged or stored.
 */
describe('phone OTP (API-100-53)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;
  let redis: Redis;

  beforeAll(async () => {
    ({ app, logs } = await createAuthApp());
    client = await openTestClient();
    redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true });
    await redis.connect();
  });

  afterAll(async () => {
    await redis.quit();
    await client.end();
    await app.close();
  });

  const send = (phone: string, purpose = 'sign_in', path = 'send', headers = {}) =>
    post(app, `/v1/auth/otp/${path}`, { phone, purpose }, headers);
  const verify = (
    phone: string,
    code: unknown,
    extra: Record<string, unknown> = {},
    headers = {},
  ) =>
    post(
      app,
      '/v1/auth/otp/verify',
      { phone, code, purpose: 'sign_in', device: DEVICE, ...extra },
      headers,
    );

  /** A wrong code that is still 6 digits. */
  const wrongFor = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  it('sign_in: send → a 6-digit code by SMS (fake), verify → a session; the phone is confirmed', async () => {
    const { phone, session: first } = await signedUpUser(app);
    const sent = await send(phone);
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toEqual({ expires_in_seconds: 600, resends_remaining: 3 });
    const sms = mailbox(app, phone).filter((m) => m.channel === 'sms');
    expect(sms).toHaveLength(1);
    expect(sms[0].text).toMatch(/^Your Atlas code is \d{6}\. It expires in 10 minutes\.$/);
    const code = latestCode(app, phone)!;
    const res = await verify(phone, code);
    expect(res.statusCode).toBe(200);
    const session = res.json<SessionBody>();
    expect(session.user.id).toBe(first.user.id);
    expect(session.user.phone).toBe(phone);
    expect(session.user.phone_confirmed_at).toEqual(expect.any(String));
    expect(
      (session.user.identities as { provider: string }[]).map((i) => i.provider).sort(),
    ).toEqual(['email', 'phone']);
    const { rows } = await client.query<{ auth_method: string }>(
      'select auth_method from public.device_sessions where id = $1',
      [session.session_id],
    );
    expect(rows[0].auth_method).toBe('otp');
    // Single use: the same code again → the code is gone (expired).
    const again = await verify(phone, code);
    expect([again.statusCode, errorOf(again).code]).toEqual([410, 'auth:otp_expired']);
    const { rows: audit } = await client.query<{ action: string }>(
      `select action from public.audit_log where target_id = $1 and action in
         ('auth.phone_verified', 'auth.login.success') order by id`,
      [session.user.id],
    );
    expect(audit.map((a) => a.action)).toEqual(['auth.phone_verified', 'auth.login.success']);
  });

  it('5 failed attempts invalidate the code (423) until a resend, which resets the count', async () => {
    const { phone } = await signedUpUser(app);
    await send(phone);
    const code = latestCode(app, phone)!;
    for (const remaining of [4, 3, 2, 1]) {
      const res = await verify(phone, wrongFor(code));
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'auth:otp_invalid',
        details: { field: 'code', attempts_remaining: remaining },
      });
    }
    const fifth = await verify(phone, wrongFor(code));
    expect([fifth.statusCode, errorOf(fifth)]).toEqual([
      423,
      expect.objectContaining({ code: 'auth:otp_invalidated', details: { attempts_remaining: 0 } }),
    ]);
    const right = await verify(phone, code);
    expect([right.statusCode, errorOf(right).code]).toEqual([423, 'auth:otp_invalidated']);
    const resent = await send(phone, 'sign_in', 'resend');
    expect(resent.json()).toEqual({ expires_in_seconds: 600, resends_remaining: 2 });
    const fresh = latestCode(app, phone)!;
    expect(
      (await verify(phone, wrongFor(fresh))).json<{ error: { details: unknown } }>().error.details,
    ).toEqual({
      field: 'code',
      attempts_remaining: 4,
    });
    expect((await verify(phone, fresh)).statusCode).toBe(200);
  });

  it('a malformed code counts as a wrong one', async () => {
    const { phone } = await signedUpUser(app);
    await send(phone);
    for (const code of ['12ab56', '12345', 123456, null]) {
      expect((await verify(phone, code)).statusCode).toBe(400);
    }
    expect(errorOf(await verify(phone, '000')).code).toBe('auth:otp_invalidated');
  });

  it('parallel wrong guesses cannot exceed 5 attempts (no lost counts)', async () => {
    const { phone } = await signedUpUser(app);
    await send(phone);
    const code = latestCode(app, phone)!;
    const replies = await Promise.all(
      Array.from({ length: 12 }, () => verify(phone, wrongFor(code))),
    );
    const statuses = replies.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([...Array<number>(4).fill(400), ...Array<number>(8).fill(423)]);
    expect((await verify(phone, code)).statusCode).toBe(423);
  });

  it('4 codes per number per 15 minutes: send + 3 resends, then 429 auth:otp_resend_limit', async () => {
    const { phone } = await signedUpUser(app);
    const remaining: number[] = [];
    for (const path of ['send', 'resend', 'resend', 'resend']) {
      const res = await send(phone, 'sign_in', path);
      expect(res.statusCode).toBe(202);
      remaining.push(res.json<{ resends_remaining: number }>().resends_remaining);
    }
    expect(remaining).toEqual([3, 2, 1, 0]);
    const over = await send(phone, 'sign_in', 'resend');
    expect(over.statusCode).toBe(429);
    expect(errorOf(over)).toMatchObject({
      code: 'auth:otp_resend_limit',
      details: { resends_remaining: 0 },
    });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(800);
    expect(mailbox(app, phone).filter((m) => m.channel === 'sms')).toHaveLength(4);
  });

  it('an unknown number gets the same answers and counts the same, and receives nothing', async () => {
    const phone = authFakePhone();
    const sent = await send(phone);
    expect([sent.statusCode, sent.json()]).toEqual([
      202,
      { expires_in_seconds: 600, resends_remaining: 3 },
    ]);
    expect(mailbox(app, phone)).toHaveLength(0);
    const res = await verify(phone, '123456');
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual({ field: 'code', attempts_remaining: 4 });
    for (let i = 0; i < 3; i += 1) await send(phone, 'sign_in', 'resend');
    expect((await send(phone, 'sign_in', 'resend')).statusCode).toBe(429);
  });

  it('a code is valid 600 s: after that 410 auth:otp_expired; never sent → 410 too', async () => {
    const { phone } = await signedUpUser(app);
    expect([(await verify(phone, '123456')).statusCode]).toEqual([410]);
    await send(phone);
    const code = latestCode(app, phone)!;
    const pending = `atlas:auth:otp:v1:pending:${identifierKey(phone)}`;
    const ttl = await redis.pttl(pending);
    expect(ttl).toBeGreaterThan(590_000);
    expect(ttl).toBeLessThanOrEqual(600_000);
    await redis.pexpire(pending, 1);
    await new Promise((r) => setTimeout(r, 20));
    const late = await verify(phone, code);
    expect([late.statusCode, errorOf(late).code]).toEqual([410, 'auth:otp_expired']);
  });

  describe('verify_phone (the signed-in user confirms their own number)', () => {
    it("needs the access token; only the caller's own number; answers {user}", async () => {
      const { phone, session } = await signedUpUser(app);
      const bearer = { authorization: `Bearer ${session.access_token}` };
      const anonymous = await send(phone, 'verify_phone');
      expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([
        401,
        'auth:not_authenticated',
      ]);
      const other = await send(authFakePhone(), 'verify_phone', 'send', bearer);
      expect([other.statusCode, errorOf(other)]).toEqual([
        422,
        expect.objectContaining({ code: 'auth:invalid_phone', details: { field: 'phone' } }),
      ]);
      expect((await send(phone, 'verify_phone', 'send', bearer)).statusCode).toBe(202);
      const res = await verify(
        phone,
        latestCode(app, phone),
        { purpose: 'verify_phone', device: undefined },
        bearer,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json<{ user: { phone_confirmed_at: string | null } }>();
      expect(Object.keys(body)).toEqual(['user']);
      expect(body.user.phone_confirmed_at).toEqual(expect.any(String));
    });
  });

  it('sign_in needs a device (422 auth:invalid_device); a bad purpose is 422 validation', async () => {
    const { phone } = await signedUpUser(app);
    await send(phone);
    const noDevice = await verify(phone, latestCode(app, phone), { device: undefined });
    expect(errorOf(noDevice)).toMatchObject({
      code: 'auth:invalid_device',
      details: { field: 'device' },
    });
    const bad = await post(app, '/v1/auth/otp/send', { phone, purpose: 'login' });
    expect(errorOf(bad)).toMatchObject({
      code: 'validation:invalid_request',
      details: { field: 'purpose' },
    });
    const badPhone = await post(app, '/v1/auth/otp/send', { phone: '555', purpose: 'sign_in' });
    expect(errorOf(badPhone)).toMatchObject({
      code: 'auth:invalid_phone',
      details: { field: 'phone' },
    });
  });

  it('AC4: codes are never logged and never stored by the API', async () => {
    const { phone } = await signedUpUser(app);
    await send(phone);
    const code = latestCode(app, phone)!;
    await verify(phone, wrongFor(code));
    await verify(phone, code);
    expect(logs.text).not.toContain(code);
    expect(logs.text).not.toContain(wrongFor(code));
    const keys = await redis.keys('atlas:auth:otp:*');
    for (const key of keys) {
      const type = await redis.type(key);
      const values: (string | null)[] =
        type === 'zset'
          ? await redis.zrange(key, '0', '-1')
          : type === 'string'
            ? [await redis.get(key)]
            : [];
      for (const value of values) expect(value).not.toBe(code);
      expect(key).not.toContain(phone);
    }
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log where detail::text like '%' || $1 || '%'`,
      [code],
    );
    expect(rows[0].n).toBe(0);
  });

  describe('with the SMS channel off', () => {
    let quiet: NestFastifyApplication;

    beforeAll(async () => {
      ({ app: quiet } = await createAuthApp({ CHANNEL_SMS_ENABLED: 'false' }));
    });

    afterAll(async () => {
      await quiet.close();
    });

    it('send answers 503 auth:sms_unavailable and counts nothing', async () => {
      const res = await post(quiet, '/v1/auth/otp/send', {
        phone: authFakePhone(),
        purpose: 'sign_in',
      });
      expect([res.statusCode, errorOf(res).code]).toEqual([503, 'auth:sms_unavailable']);
    });
  });
});
