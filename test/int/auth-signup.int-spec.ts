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
  latestCode,
  latestLink,
  mailbox,
  post,
  type SessionBody,
  signedUpUser,
} from '../support/auth-api';
import { openTestClient } from '../support/database';

/**
 * API-100-52: sign-up (A1), email verification (A2) and resend (A3). D5a password policy, D78
 * (Stage 3 [B1], replaces D5b): email OR phone, a duplicate is 409 `signup:already_registered`, argon2id, the link scheme and its 300 s single use, the fake
 * email channel, audit `auth.signup` / `auth.email_verified`, and nothing secret in the logs.
 */
describe('sign-up and email verification (API-100-52)', () => {
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

  const signup = (body: Record<string, unknown>) =>
    post(app, '/v1/auth/signup', {
      email: fakeEmail(),
      password: GOOD_PASSWORD,
      phone: authFakePhone(),
      full_name: 'Signup Example',
      device: DEVICE,
      ...body,
    });

  async function userRow(email: string) {
    const { rows } = await client.query<{
      id: string;
      email: string;
      phone: string | null;
      email_confirmed_at: Date | null;
      phone_confirmed_at: Date | null;
      metadata: Record<string, unknown>;
    }>(
      'select id, email::text, phone, email_confirmed_at, phone_confirmed_at, metadata from public.users where email = $1',
      [email],
    );
    return rows;
  }

  describe('A1 POST /v1/auth/signup', () => {
    it('creates the user (phone unverified), an argon2id credential, an email identity and a 300 s link; answers 202', async () => {
      const email = fakeEmail();
      const phone = authFakePhone();
      const res = await signup({ email: `  ${email.toUpperCase()} `, phone });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        verification: { channel: 'email', expires_in_seconds: 300 },
        verifications: [
          { channel: 'email', expires_in_seconds: 300 },
          { channel: 'phone', expires_in_seconds: 600 },
        ],
      });
      const [user] = await userRow(email);
      expect(user).toMatchObject({
        email,
        phone,
        email_confirmed_at: null,
        phone_confirmed_at: null,
        metadata: { full_name: 'Signup Example' },
      });
      expect(latestCode(app, phone)).toMatch(/^\d{6}$/);
      const { rows: creds } = await client.query<{ hash_algo: string; password_hash: string }>(
        'select hash_algo, password_hash from public.user_credentials where user_id = $1',
        [user.id],
      );
      expect(creds[0].hash_algo).toBe('argon2id');
      expect(creds[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(creds[0].password_hash).not.toContain(GOOD_PASSWORD);
      const { rows: identities } = await client.query(
        'select provider, provider_subject, email::text from public.user_identities where user_id = $1',
        [user.id],
      );
      expect(identities).toEqual([{ provider: 'email', provider_subject: user.id, email }]);
      const { rows: tokens } = await client.query<{ purpose: string; seconds: number }>(
        `select purpose, round(extract(epoch from expires_at - created_at))::int as seconds
           from public.auth_tokens where user_id = $1`,
        [user.id],
      );
      expect(tokens).toEqual([{ purpose: 'email_verify', seconds: 300 }]);
      const link = latestLink(app, email);
      expect(link?.type).toBe('signup');
      expect(
        link?.url.startsWith('io.supabase.atlasmobile://login-callback/?type=signup&token='),
      ).toBe(true);
      const { rows: audit } = await client.query(
        `select action, actor_user_id::text, target_id::text, detail from public.audit_log
          where action = 'auth.signup' and target_id = $1`,
        [user.id],
      );
      expect(audit).toEqual([
        {
          action: 'auth.signup',
          actor_user_id: user.id,
          target_id: user.id,
          detail: { method: 'password', platform: 'android' },
        },
      ]);
    });

    it('D78: email only → 202, an emailed link only, no phone stored', async () => {
      const email = fakeEmail();
      const res = await signup({ email, phone: undefined });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        verification: { channel: 'email', expires_in_seconds: 300 },
        verifications: [{ channel: 'email', expires_in_seconds: 300 }],
      });
      const [user] = await userRow(email);
      expect(user.phone).toBeNull();
      expect(latestLink(app, email)?.type).toBe('signup');
    });

    it('D78: phone only → 202, a texted code; verifying it signs in and confirms the phone; then phone + password signs in', async () => {
      const phone = authFakePhone();
      const res = await signup({ email: null, phone });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        verification: { channel: 'phone', expires_in_seconds: 600 },
        verifications: [{ channel: 'phone', expires_in_seconds: 600 }],
      });
      const { rows } = await client.query<{ id: string; email: string | null }>(
        'select id, email::text from public.users where phone = $1',
        [phone],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBeNull();
      const { rows: identities } = await client.query(
        'select provider from public.user_identities where user_id = $1',
        [rows[0].id],
      );
      expect(identities).toEqual([]);
      const code = latestCode(app, phone)!;
      const verified = await post(app, '/v1/auth/otp/verify', {
        phone,
        code,
        purpose: 'sign_in',
        device: DEVICE,
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json<SessionBody>().user.phone_confirmed_at).toEqual(expect.any(String));
      const login = await post(app, '/v1/auth/login', {
        phone,
        password: GOOD_PASSWORD,
        device: DEVICE,
      });
      expect(login.statusCode).toBe(200);
    });

    it.each([
      ['both missing', { email: undefined, phone: undefined }],
      ['both null', { email: null, phone: null }],
      ['both blank', { email: '  ', phone: '' }],
    ])('D78: %s → 422 signup:contact_required (field contact)', async (_label, body) => {
      const res = await signup(body);
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'signup:contact_required',
        details: { field: 'contact' },
      });
    });

    it('D78: an existing email (confirmed or not) → 409 signup:already_registered field email; nothing written or sent', async () => {
      const { email } = await signedUpUser(app);
      const before = mailbox(app, email).length;
      const res = await signup({ email: email.toUpperCase() });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'signup:already_registered',
        details: { field: 'email' },
      });
      expect(await userRow(email)).toHaveLength(1);
      expect(mailbox(app, email)).toHaveLength(before);

      const unconfirmed = fakeEmail();
      expect((await signup({ email: unconfirmed })).statusCode).toBe(202);
      const again = await signup({ email: unconfirmed });
      expect([again.statusCode, errorOf(again).details]).toEqual([409, { field: 'email' }]);
    });

    it('D78: an existing phone → 409 signup:already_registered field phone; no user is created', async () => {
      const phone = authFakePhone();
      expect((await signup({ phone })).statusCode).toBe(202);
      const email = fakeEmail();
      const res = await signup({ email, phone });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'signup:already_registered',
        details: { field: 'phone' },
      });
      expect(await userRow(email)).toHaveLength(0);
      const phoneOnly = await signup({ email: null, phone });
      expect([phoneOnly.statusCode, errorOf(phoneOnly).details]).toEqual([409, { field: 'phone' }]);
    });

    it.each([
      ['short', 'Ab1defg'],
      ['no lowercase', 'ABCDEFG1'],
      ['no uppercase', 'abcdefg1'],
      ['no digit', 'Abcdefgh'],
      ['over 128 characters', `Ab1${'x'.repeat(126)}`],
      ['not a string', 12345678],
    ])('D5a: a password with %s → 422 auth:weak_password', async (_label, password) => {
      const res = await signup({ password });
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toEqual({
        code: 'auth:weak_password',
        message: expect.any(String) as string,
        details: { field: 'password' },
      });
    });

    it('checks fields in order and names them: email, password, phone, full_name, device', async () => {
      const all = { email: 'nope', password: 'weak', phone: '12', full_name: ' ', device: {} };
      const order: [Record<string, unknown>, string, string][] = [
        [all, 'auth:invalid_email', 'email'],
        [{ ...all, email: fakeEmail() }, 'auth:weak_password', 'password'],
        [{ ...all, email: fakeEmail(), password: GOOD_PASSWORD }, 'auth:invalid_phone', 'phone'],
        [
          { ...all, email: fakeEmail(), password: GOOD_PASSWORD, phone: authFakePhone() },
          'auth:invalid_full_name',
          'full_name',
        ],
        [
          {
            ...all,
            email: fakeEmail(),
            password: GOOD_PASSWORD,
            phone: authFakePhone(),
            full_name: 'Ok',
          },
          'auth:invalid_device',
          'device.platform',
        ],
      ];
      for (const [body, code, field] of order) {
        const res = await post(app, '/v1/auth/signup', body);
        expect(res.statusCode).toBe(422);
        expect(errorOf(res)).toMatchObject({ code, details: { field } });
      }
      const notObject = await post(app, '/v1/auth/signup', [1]);
      expect(errorOf(notObject).code).toBe('validation:invalid_request');
    });

    it('a concurrent burst of sign-ups with one email creates exactly one user', async () => {
      const email = fakeEmail();
      const replies = await Promise.all(Array.from({ length: 8 }, () => signup({ email })));
      const statuses = replies.map((r) => r.statusCode).sort();
      // 4 emails per address per 15 minutes: the other 4 are refused before any write.
      // D78: of the 4 sent through, one creates the user and 3 are duplicates (409).
      expect(statuses).toEqual([202, 409, 409, 409, 429, 429, 429, 429]);
      expect(await userRow(email)).toHaveLength(1);
    });

    it('per IP: 30 sign-ups per 5 minutes, then 429 rate_limit:exceeded', async () => {
      const ip = '10.200.0.1';
      for (let i = 0; i < 30; i += 1) {
        const res = await post(app, '/v1/auth/signup', {}, { 'x-forwarded-for': ip });
        expect(res.statusCode).toBe(422);
      }
      const over = await post(app, '/v1/auth/signup', {}, { 'x-forwarded-for': ip });
      expect([over.statusCode, errorOf(over).code]).toEqual([429, 'rate_limit:exceeded']);
    });
  });

  describe('A2 POST /v1/auth/email/verify', () => {
    it('confirms the email and answers a Session; the session works; audit auth.email_verified', async () => {
      const email = fakeEmail();
      await signup({ email });
      const link = latestLink(app, email)!;
      const res = await post(
        app,
        '/v1/auth/email/verify',
        { token: link.token, device: { ...DEVICE, device_name: ' Pixel ' } },
        { 'user-agent': 'AtlasTest/1.0' },
      );
      expect(res.statusCode).toBe(200);
      const session = res.json<SessionBody>();
      expect(Object.keys(session).sort()).toEqual([
        'access_token',
        'access_token_expires_at',
        'refresh_token',
        'refresh_token_expires_at',
        'session_id',
        'user',
      ]);
      expect(Object.keys(session.user).sort()).toEqual([
        'created_at',
        'email',
        'email_confirmed_at',
        'id',
        'identities',
        'phone',
        'phone_confirmed_at',
      ]);
      expect(session.user.email).toBe(email);
      expect(session.user.email_confirmed_at).toEqual(expect.any(String));
      expect(session.user.phone_confirmed_at).toBeNull();
      expect(session.user.identities).toEqual([
        { provider: 'email', created_at: expect.any(String) as string },
      ]);
      const accessMs = Date.parse(session.access_token_expires_at) - Date.now();
      expect(accessMs).toBeGreaterThan(14 * 60_000);
      expect(accessMs).toBeLessThanOrEqual(15 * 60_000);
      const refreshMs = Date.parse(session.refresh_token_expires_at) - Date.now();
      expect(Math.round(refreshMs / 86_400_000)).toBe(7);

      const { rows } = await client.query(
        `select user_id::text, platform, device_name, app_version, auth_method, user_agent,
                revoked_at from public.device_sessions where id = $1`,
        [session.session_id],
      );
      expect(rows).toEqual([
        {
          user_id: session.user.id,
          platform: 'android',
          device_name: 'Pixel',
          app_version: '1.0.0',
          auth_method: 'email_link',
          user_agent: 'AtlasTest/1.0',
          revoked_at: null,
        },
      ]);
      const open = await app.inject({
        method: 'GET',
        url: '/v1/me/incidents/open',
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      expect(open.statusCode).toBe(200);
      const { rows: audit } = await client.query<{ n: number }>(
        `select count(*)::int as n from public.audit_log
          where action = 'auth.email_verified' and target_id = $1`,
        [session.user.id],
      );
      expect(audit[0].n).toBe(1);
    });

    it('a link is single use (400 link_invalid), expires after 300 s (410 link_expired); junk is 400', async () => {
      const email = fakeEmail();
      await signup({ email });
      const link = latestLink(app, email)!;
      expect(
        (await post(app, '/v1/auth/email/verify', { token: link.token, device: DEVICE }))
          .statusCode,
      ).toBe(200);
      const again = await post(app, '/v1/auth/email/verify', { token: link.token, device: DEVICE });
      expect([again.statusCode, errorOf(again).code]).toEqual([400, 'auth:link_invalid']);

      const other = fakeEmail();
      await signup({ email: other });
      const expiring = latestLink(app, other)!;
      await client.query(
        `update public.auth_tokens set expires_at = now() - interval '1 second'
          where user_id = (select id from public.users where email = $1)`,
        [other],
      );
      const late = await post(app, '/v1/auth/email/verify', {
        token: expiring.token,
        device: DEVICE,
      });
      expect([late.statusCode, errorOf(late).code]).toEqual([410, 'auth:link_expired']);
      expect((await userRow(other))[0].email_confirmed_at).toBeNull();

      for (const token of ['', 'not a token!', 'x'.repeat(600), 42]) {
        const junk = await post(app, '/v1/auth/email/verify', { token, device: DEVICE });
        expect([junk.statusCode, errorOf(junk).code]).toEqual([400, 'auth:link_invalid']);
      }
      const noDevice = await post(app, '/v1/auth/email/verify', { token: 'abc' });
      expect(noDevice.statusCode).toBe(422);
      expect(errorOf(noDevice)).toMatchObject({
        code: 'auth:invalid_device',
        details: { field: 'device' },
      });
    });
  });

  describe('A3 POST /v1/auth/email/resend', () => {
    it('always 202: a new link for an unconfirmed account, nothing for a confirmed or unknown one', async () => {
      const email = fakeEmail();
      await signup({ email });
      const first = latestLink(app, email)!;
      const res = await post(app, '/v1/auth/email/resend', { email });
      expect(res.statusCode).toBe(202);
      expect(res.body).toBe('');
      expect(latestLink(app, email)!.token).not.toBe(first.token);

      const confirmed = await signedUpUser(app);
      const before = mailbox(app, confirmed.email).length;
      expect(
        (await post(app, '/v1/auth/email/resend', { email: confirmed.email })).statusCode,
      ).toBe(202);
      expect(mailbox(app, confirmed.email)).toHaveLength(before);

      const unknown = fakeEmail();
      expect((await post(app, '/v1/auth/email/resend', { email: unknown })).statusCode).toBe(202);
      expect(mailbox(app, unknown)).toHaveLength(0);
    });

    it('magic_link: a sign-in link (type=magiclink) that opens a session for a confirmed account', async () => {
      const { email } = await signedUpUser(app);
      expect(
        (await post(app, '/v1/auth/email/resend', { email, purpose: 'magic_link' })).statusCode,
      ).toBe(202);
      const link = latestLink(app, email)!;
      expect(link.type).toBe('magiclink');
      const res = await post(app, '/v1/auth/email/verify', { token: link.token, device: DEVICE });
      expect(res.statusCode).toBe(200);
      expect(res.json<SessionBody>().user.email).toBe(email);
      const bad = await post(app, '/v1/auth/email/resend', { email, purpose: 'reset' });
      expect([bad.statusCode, errorOf(bad)]).toEqual([
        422,
        expect.objectContaining({
          code: 'validation:invalid_request',
          details: { field: 'purpose' },
        }),
      ]);
    });

    it('4 emails per address per 15 minutes (sign-up included): the 5th → 429 auth:over_email_send_rate_limit', async () => {
      const email = fakeEmail();
      await signup({ email });
      for (let i = 0; i < 3; i += 1) {
        expect((await post(app, '/v1/auth/email/resend', { email })).statusCode).toBe(202);
      }
      const over = await post(app, '/v1/auth/email/resend', { email });
      expect(over.statusCode).toBe(429);
      expect(errorOf(over).code).toBe('auth:over_email_send_rate_limit');
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      // An unknown address has the same limit (no enumeration through the limit).
      const unknown = fakeEmail();
      for (let i = 0; i < 4; i += 1) await post(app, '/v1/auth/email/resend', { email: unknown });
      expect((await post(app, '/v1/auth/email/resend', { email: unknown })).statusCode).toBe(429);
    });
  });

  it('never logs a password, a link token, an email address or a phone number', async () => {
    const email = fakeEmail();
    const phone = authFakePhone();
    await signup({ email, phone });
    const link = latestLink(app, email)!;
    await post(app, '/v1/auth/email/verify', { token: link.token, device: DEVICE });
    const text = logs.text;
    for (const secret of [GOOD_PASSWORD, link.token, email, phone, phone.slice(1)]) {
      expect(text).not.toContain(secret);
    }
  });

  describe('with the email channel off (the default; no provider yet)', () => {
    let quiet: NestFastifyApplication;
    let quietLogs: LogCapture;

    beforeAll(async () => {
      ({ app: quiet, logs: quietLogs } = await createAuthApp({ CHANNEL_EMAIL_ENABLED: 'false' }));
    });

    afterAll(async () => {
      await quiet.close();
    });

    it('sign-up still answers 202 and sends nothing (logged by kind, without the address)', async () => {
      const email = fakeEmail();
      const res = await post(quiet, '/v1/auth/signup', {
        email,
        password: GOOD_PASSWORD,
        phone: authFakePhone(),
        full_name: 'Quiet Example',
        device: DEVICE,
      });
      expect(res.statusCode).toBe(202);
      expect(mailbox(quiet, email)).toHaveLength(0);
      const line = quietLogs.lines.find((l) => l.msg === 'auth email not sent: channel disabled');
      expect(line).toMatchObject({ channel: 'email', kind: 'signup' });
      expect(quietLogs.text).not.toContain(email);
    });
  });
});
