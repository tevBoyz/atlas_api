import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import {
  authFakePhone,
  createAuthApp,
  DEVICE,
  errorOf,
  fakeEmail,
  latestLink,
  mailbox,
  post,
  type SessionBody,
  signedUpUser,
} from '../support/auth-api';
import { openTestClient } from '../support/database';

/**
 * API-100-57: forgot (always 202, recovery link scheme, single use, 300 s) and reset (password
 * policy, same password, lockout cleared, other sessions revoked, a new session).
 */
const NEW_PASSWORD = ['New', 'Secret', '42x'].join('');

describe('password reset (API-100-57)', () => {
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

  const forgot = (email: string) => post(app, '/v1/auth/password/forgot', { email });
  const reset = (token: string, password: unknown) =>
    post(app, '/v1/auth/password/reset', { token, new_password: password, device: DEVICE });

  it('A14: 202 always; a type=recovery link for an account, nothing for an unknown address', async () => {
    const { email } = await signedUpUser(app);
    const res = await forgot(email);
    expect([res.statusCode, res.body]).toEqual([202, '']);
    const link = latestLink(app, email)!;
    expect(link.type).toBe('recovery');
    expect(
      link.url.startsWith('io.supabase.atlasmobile://login-callback/?type=recovery&token='),
    ).toBe(true);
    const unknown = fakeEmail();
    expect((await forgot(unknown)).statusCode).toBe(202);
    expect(mailbox(app, unknown)).toHaveLength(0);
    const bad = await post(app, '/v1/auth/password/forgot', { email: 'nope' });
    expect([bad.statusCode, errorOf(bad).code]).toEqual([422, 'auth:invalid_email']);
  });

  it('A15: new password → Session; old password refused; lockout cleared; OTHER sessions revoked', async () => {
    const { email, password, session } = await signedUpUser(app);
    await client.query(
      `insert into public.login_lockouts (email, failed_attempts, last_failed_at) values ($1, 4, now())`,
      [email],
    );
    await forgot(email);
    const res = await reset(latestLink(app, email)!.token, NEW_PASSWORD);
    expect(res.statusCode).toBe(200);
    const fresh = res.json<SessionBody>();
    expect(fresh.user.id).toBe(session.user.id);
    const { rows } = await client.query<{
      id: string;
      revoke_reason: string | null;
      auth_method: string;
    }>(
      'select id::text, revoke_reason, auth_method from public.device_sessions where user_id = $1 order by created_at',
      [session.user.id],
    );
    expect(rows).toEqual([
      { id: session.session_id, revoke_reason: 'password_reset', auth_method: 'email_link' },
      { id: fresh.session_id, revoke_reason: null, auth_method: 'recovery' },
    ]);
    expect(
      (await client.query('select 1 from public.login_lockouts where email = $1', [email])).rows,
    ).toHaveLength(0);
    const old = await post(app, '/v1/auth/login', { email, password, device: DEVICE });
    expect(errorOf(old).code).toBe('auth:invalid_credentials');
    expect(
      (await post(app, '/v1/auth/login', { email, password: NEW_PASSWORD, device: DEVICE }))
        .statusCode,
    ).toBe(200);
    const { rows: audit } = await client.query<{ detail: unknown }>(
      `select detail from public.audit_log where action = 'auth.password.reset' and target_id = $1`,
      [session.user.id],
    );
    expect(audit).toEqual([{ detail: { sessions_revoked: 1 } }]);
  });

  it('a weak or unchanged password is 422 and leaves the link usable; then single use', async () => {
    const { email, password } = await signedUpUser(app);
    await forgot(email);
    const token = latestLink(app, email)!.token;
    const weak = await reset(token, 'short');
    expect([weak.statusCode, errorOf(weak)]).toEqual([
      422,
      expect.objectContaining({ code: 'auth:weak_password', details: { field: 'new_password' } }),
    ]);
    const same = await reset(token, password);
    expect([same.statusCode, errorOf(same).code]).toEqual([422, 'auth:same_password']);
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(200);
    const again = await reset(token, `${NEW_PASSWORD}9`);
    expect([again.statusCode, errorOf(again).code]).toEqual([400, 'auth:link_invalid']);
  });

  it('an expired link → 410 auth:link_expired; a verification link is not a reset link', async () => {
    const { email } = await signedUpUser(app);
    await forgot(email);
    const token = latestLink(app, email)!.token;
    await client.query(
      `update public.auth_tokens set expires_at = now() - interval '1 second'
        where purpose = 'password_reset' and user_id = (select id from public.users where email = $1)`,
      [email],
    );
    const late = await reset(token, NEW_PASSWORD);
    expect([late.statusCode, errorOf(late).code]).toEqual([410, 'auth:link_expired']);

    const other = fakeEmail();
    await post(app, '/v1/auth/signup', {
      email: other,
      password: NEW_PASSWORD,
      phone: authFakePhone(),
      full_name: 'Other',
      device: DEVICE,
    });
    const verifyToken = latestLink(app, other)!.token;
    expect(errorOf(await reset(verifyToken, `${NEW_PASSWORD}1`)).code).toBe('auth:link_invalid');
  });

  it('a reset confirms an unconfirmed email (the link proved the address)', async () => {
    const email = fakeEmail();
    await post(app, '/v1/auth/signup', {
      email,
      password: NEW_PASSWORD,
      phone: authFakePhone(),
      full_name: 'Unconfirmed',
      device: DEVICE,
    });
    await forgot(email);
    const res = await reset(latestLink(app, email)!.token, `${NEW_PASSWORD}7`);
    expect(res.json<SessionBody>().user.email_confirmed_at).toEqual(expect.any(String));
  });
});
