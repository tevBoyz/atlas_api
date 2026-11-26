import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import type { LogCapture } from '../../src/testing/test-app';
import {
  authFakePhone,
  createAuthApp,
  DEVICE,
  errorOf,
  fakeEmail,
  GOOD_PASSWORD,
  post,
  randomIp,
  type SessionBody,
  signedUpUser,
} from '../support/auth-api';
import { openTestClient } from '../support/database';
import { createUser } from '../support/fixtures';

/**
 * API-100-54: password sign-in with the lockout of spec §6.8 rules 42-48 (`login_lockouts`), plus
 * confirmation checks, the per-IP throttles, uniform answers for unknown identifiers, concurrency
 * and audit.
 */
interface Status {
  locked: boolean;
  locked_until: string | null;
  failed_attempts: number;
}

describe('password sign-in with lockout (API-100-54)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;

  beforeAll(async () => {
    ({ app, logs } = await createAuthApp());
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const login = (body: Record<string, unknown>, ip = randomIp()) =>
    post(app, '/v1/auth/login', { device: DEVICE, ...body }, { 'x-forwarded-for': ip });

  const lockoutStatus = (query: string, ip = randomIp()) =>
    app.inject({
      method: 'GET',
      url: `/v1/auth/lockout-status?${query}`,
      headers: { 'x-forwarded-for': ip },
    });

  async function row(key: string) {
    const { rows } = await client.query<{
      failed_attempts: number;
      locked: boolean;
      locked_until: Date | null;
      last_failed_at: Date | null;
    }>(
      `select failed_attempts, (locked_until > now()) is true as locked, locked_until, last_failed_at
         from public.login_lockouts where email = $1`,
      [key],
    );
    return rows[0];
  }

  describe('success', () => {
    it('email + password → 200 Session (auth_method password); failures are cleared; audited', async () => {
      const { email, password, session: first } = await signedUpUser(app);
      expect((await login({ email, password: 'Wrong1234' })).statusCode).toBe(401);
      expect((await row(email))?.failed_attempts).toBe(1);
      const res = await login({ email: ` ${email.toUpperCase()} `, password });
      expect(res.statusCode).toBe(200);
      const session = res.json<SessionBody>();
      expect(session.user.id).toBe(first.user.id);
      expect(await row(email)).toBeUndefined();
      const { rows } = await client.query<{ auth_method: string }>(
        'select auth_method from public.device_sessions where id = $1',
        [session.session_id],
      );
      expect(rows[0].auth_method).toBe('password');
      const { rows: audit } = await client.query<{ detail: unknown }>(
        `select detail from public.audit_log where action = 'auth.login.success' and target_id = $1`,
        [first.user.id],
      );
      expect(audit.map((a) => a.detail)).toContainEqual({
        method: 'password',
        identifier: 'email',
        rehashed: false,
      });
    });

    it('phone + password once the phone is confirmed; 403 auth:phone_not_confirmed before', async () => {
      const { phone, password } = await signedUpUser(app);
      const before = await login({ phone, password });
      expect([before.statusCode, errorOf(before).code]).toEqual([403, 'auth:phone_not_confirmed']);
      await client.query('update public.users set phone_confirmed_at = now() where phone = $1', [
        phone,
      ]);
      const res = await login({ phone: phone.slice(1), password });
      expect(res.statusCode).toBe(200);
    });

    it('403 auth:email_not_confirmed for an unconfirmed email; it neither counts nor clears', async () => {
      const email = fakeEmail();
      await post(app, '/v1/auth/signup', {
        email,
        password: GOOD_PASSWORD,
        phone: authFakePhone(),
        full_name: 'Unconfirmed',
        device: DEVICE,
      });
      await login({ email, password: 'Wrong1234' });
      const res = await login({ email, password: GOOD_PASSWORD });
      expect([res.statusCode, errorOf(res).code]).toEqual([403, 'auth:email_not_confirmed']);
      expect((await row(email))?.failed_attempts).toBe(1);
    });
  });

  describe('rules 42 and 45: 5 failures in 15 minutes lock for 15 minutes', () => {
    it('401 with the status for failures 1-4, 423 at the 5th; no extension while locked; right password refused', async () => {
      const { email, password } = await signedUpUser(app);
      for (let n = 1; n <= 4; n += 1) {
        const res = await login({ email, password: 'Wrong1234' });
        expect(res.statusCode).toBe(401);
        expect(errorOf(res)).toMatchObject({
          code: 'auth:invalid_credentials',
          details: { locked: false, locked_until: null, failed_attempts: n },
        });
      }
      const fifth = await login({ email, password: 'Wrong1234' });
      expect(fifth.statusCode).toBe(423);
      const details = errorOf(fifth).details as unknown as Status;
      expect(errorOf(fifth).code).toBe('login_lockout:locked');
      expect(details.locked).toBe(true);
      expect(details.failed_attempts).toBe(5);
      const until = Date.parse(details.locked_until!);
      expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000);

      const sixth = await login({ email, password: 'Wrong1234' });
      expect([sixth.statusCode, errorOf(sixth).details]).toEqual([423, details]);
      const right = await login({ email, password });
      expect([right.statusCode, errorOf(right).code]).toEqual([423, 'login_lockout:locked']);
      expect(Date.parse((await row(email)).locked_until!.toISOString())).toBe(until);
      const status = await lockoutStatus(`email=${encodeURIComponent(email)}`);
      expect(status.json()).toEqual(details);
    });

    it('a lock that has expired resets on the next status/attempt; a failure older than 15 minutes resets the count', async () => {
      const { email, password } = await signedUpUser(app);
      await client.query(
        `insert into public.login_lockouts (email, failed_attempts, locked_until, last_failed_at)
         values ($1, 5, now() - interval '1 second', now() - interval '15 minutes')`,
        [email],
      );
      expect((await lockoutStatus(`email=${encodeURIComponent(email)}`)).json()).toEqual({
        locked: false,
        locked_until: null,
        failed_attempts: 0,
      });
      await client.query(
        `update public.login_lockouts set failed_attempts = 4, last_failed_at = now() - interval '16 minutes'
          where email = $1`,
        [email],
      );
      const res = await login({ email, password: 'Wrong1234' });
      expect(errorOf(res).details).toEqual({
        locked: false,
        locked_until: null,
        failed_attempts: 1,
      });
      expect((await login({ email, password })).statusCode).toBe(200);
    });

    it('rule 44: phone sign-in of an account with an email shares the email counter', async () => {
      const { email, phone } = await signedUpUser(app);
      await client.query('update public.users set phone_confirmed_at = now() where phone = $1', [
        phone,
      ]);
      for (let i = 0; i < 3; i += 1) await login({ email, password: 'Wrong1234' });
      expect(errorOf(await login({ phone, password: 'Wrong1234' })).details).toMatchObject({
        failed_attempts: 4,
      });
      expect((await login({ phone, password: 'Wrong1234' })).statusCode).toBe(423);
      expect(await row(phone)).toBeUndefined();
      expect((await lockoutStatus(`phone=${encodeURIComponent(phone)}`)).json()).toMatchObject({
        locked: true,
        failed_attempts: 5,
      });
    });

    it('rule 45: unknown email / phone get the same answers (and their own counters)', async () => {
      const email = fakeEmail('unknown');
      const phone = authFakePhone();
      const a = await login({ email, password: 'Wrong1234' });
      expect([a.statusCode, errorOf(a)]).toEqual([
        401,
        expect.objectContaining({
          code: 'auth:invalid_credentials',
          details: { locked: false, locked_until: null, failed_attempts: 1 },
        }),
      ]);
      const b = await login({ phone, password: 'Wrong1234' });
      expect(errorOf(b).details).toEqual({ locked: false, locked_until: null, failed_attempts: 1 });
      expect((await row(phone))?.failed_attempts).toBe(1);
      expect((await lockoutStatus(`email=${encodeURIComponent(email)}`)).json()).toEqual({
        locked: false,
        locked_until: null,
        failed_attempts: 1,
      });
    });

    it('10 parallel wrong passwords: exactly 5 counted, one lock, never extended', async () => {
      const { email } = await signedUpUser(app);
      const replies = await Promise.all(
        Array.from({ length: 10 }, () => login({ email, password: 'Wrong1234' })),
      );
      const statuses = replies.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 423, 423, 423, 423, 423, 423]);
      const after = await row(email);
      expect(after).toMatchObject({ failed_attempts: 5, locked: true });
      const lockedUntil = new Set(
        replies
          .filter((r) => r.statusCode === 423)
          .map((r) => (errorOf(r).details as unknown as Status).locked_until),
      );
      expect(lockedUntil.size).toBe(1);
    });
  });

  describe('identifiers (login_lockout:* codes)', () => {
    it.each<[Record<string, unknown>, string]>([
      [{ email: 'a@b.test', phone: '+12015550101' }, 'login_lockout:identifier_exclusive'],
      [{}, 'login_lockout:identifier_required'],
      [{ email: '  ' }, 'login_lockout:email_required'],
      [{ email: 'nope' }, 'login_lockout:invalid_email'],
      [{ phone: '' }, 'login_lockout:phone_required'],
      [{ phone: '123' }, 'login_lockout:invalid_phone'],
    ])('%j → 422 %s (login and lockout-status)', async (identifier, code) => {
      const res = await login({ ...identifier, password: 'x' });
      expect([res.statusCode, errorOf(res).code]).toEqual([422, code]);
      const query = Object.entries(identifier)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
      const status = await lockoutStatus(query);
      expect([status.statusCode, errorOf(status).code]).toEqual([422, code]);
    });
  });

  describe('rule 48: per-IP throttles', () => {
    it('login and lockout-status share 60 per 5 minutes per IP → 429 login_lockout:rate_limited', async () => {
      const ip = '10.201.0.1';
      for (let i = 0; i < 30; i += 1) await lockoutStatus(`email=a${i}%40b.test`, ip);
      for (let i = 0; i < 30; i += 1) await login({ email: `a${i}@b.test`, password: 'x' }, ip);
      const over = await login({ email: 'a@b.test', password: 'x' }, ip);
      expect([over.statusCode, errorOf(over).code]).toEqual([429, 'login_lockout:rate_limited']);
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      expect((await lockoutStatus('email=a%40b.test', ip)).statusCode).toBe(429);
    });

    it('15 wrong passwords per 5 minutes per IP; the 16th → 429 and is not counted', async () => {
      const ip = '10.202.0.1';
      for (let i = 0; i < 15; i += 1) {
        expect((await login({ email: `w${i}@b.test`, password: 'x' }, ip)).statusCode).toBe(401);
      }
      const over = await login({ email: 'w-last@b.test', password: 'x' }, ip);
      expect([over.statusCode, errorOf(over).code]).toEqual([429, 'login_lockout:rate_limited']);
      expect(await row('w-last@b.test')).toBeUndefined();
    });
  });

  describe('rule 44: the lockout key of a phone sign-in', () => {
    async function keys(...candidates: string[]): Promise<string[]> {
      const { rows } = await client.query<{ email: string }>(
        `select email from public.login_lockouts where email = any($1::text[]) order by 1`,
        [candidates],
      );
      return rows.map((r) => r.email);
    }

    it('an account with an email → its email; a phone-only account or an unknown number → E.164', async () => {
      const withEmail = await createUser(client, { phone: true, profile: false });
      const phoneOnly = await createUser(client, { phone: true, profile: false });
      await client.query('update public.users set email = null where id = $1', [phoneOnly.id]);
      const unknown = authFakePhone();
      const expected: [string, string][] = [
        [withEmail.phone!, withEmail.email],
        [phoneOnly.phone!, phoneOnly.phone!],
        [unknown, unknown],
      ];
      for (const [phone, key] of expected) {
        await login({ phone, password: 'Wrong1234' });
        expect(await keys(withEmail.email, phoneOnly.email, phone)).toEqual([key]);
        await client.query('delete from public.login_lockouts where email = $1', [key]);
      }
    });
  });

  it('never logs the password or the identifier', async () => {
    const { email, password } = await signedUpUser(app);
    await login({ email, password: 'Wrong9876x' });
    await login({ email, password });
    expect(logs.text).not.toContain(password);
    expect(logs.text).not.toContain('Wrong9876x');
    expect(logs.text).not.toContain(email);
  });
});
