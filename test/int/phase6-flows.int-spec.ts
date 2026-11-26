import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { authHeader } from '../../src/testing/test-tokens';
import {
  createAuthApp,
  DEVICE,
  errorOf,
  fakeEmail,
  GOOD_PASSWORD,
  latestCode,
  latestLink,
  legacyUser,
  post,
  type SessionBody,
  authFakePhone,
} from '../support/auth-api';
import { openTestClient } from '../support/database';
import { fakePushToken } from '../support/device-api';

/**
 * API-100-59 AC3: the checklist. Every app flow of spec §8.1-§8.8 walked step
 * for step against the API, in the order the app's `AtlasAuth` / `SessionStore` performs it.
 */
describe('Phase 6 gate: the auth flows of spec §8 against the API (API-100-59 AC3)', () => {
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

  const bearer = (s: SessionBody) => ({ authorization: `Bearer ${s.access_token}` });
  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });

  it('§8.1 sign up: name, phone (E.164), email, password → "check your email", phone stored unverified', async () => {
    const email = fakeEmail('flow');
    const phone = authFakePhone();
    const res = await post(app, '/v1/auth/signup', {
      email,
      password: GOOD_PASSWORD,
      phone,
      full_name: 'Flow Example',
      device: DEVICE,
    });
    expect([res.statusCode, res.json()]).toEqual([
      202,
      { verification: { channel: 'email', expires_in_seconds: 300 } },
    ]);
    const { rows } = await client.query<{ phone: string; confirmed: boolean }>(
      'select phone, phone_confirmed_at is not null as confirmed from public.users where email = $1',
      [email],
    );
    expect(rows).toEqual([{ phone, confirmed: false }]);
  });

  it('§8.2 email confirmation: the login-callback link (type=signup) → a session; resend → a new link', async () => {
    const email = fakeEmail('flow');
    await post(app, '/v1/auth/signup', {
      email,
      password: GOOD_PASSWORD,
      phone: authFakePhone(),
      full_name: 'Flow Example',
      device: DEVICE,
    });
    const first = latestLink(app, email)!;
    expect(first.url).toMatch(
      /^io\.supabase\.atlasmobile:\/\/login-callback\/\?type=signup&token=/,
    );
    expect(
      (await post(app, '/v1/auth/email/resend', { email, purpose: 'signup' })).statusCode,
    ).toBe(202);
    const second = latestLink(app, email)!;
    const res = await post(app, '/v1/auth/email/verify', { token: second.token, device: DEVICE });
    expect(res.statusCode).toBe(200);
    const user = res.json<SessionBody>().user;
    expect(user.email_confirmed_at).not.toBeNull();
  });

  it('§8.3 phone OTP: send (6 digits, 600 s), resend, verify → session; limits on the server', async () => {
    const { session } = await legacyUser(app, client);
    const phone = session.user.phone!;
    expect((await post(app, '/v1/auth/otp/send', { phone, purpose: 'sign_in' })).json()).toEqual({
      expires_in_seconds: 600,
      resends_remaining: 3,
    });
    expect((await post(app, '/v1/auth/otp/resend', { phone, purpose: 'sign_in' })).statusCode).toBe(
      202,
    );
    const res = await post(app, '/v1/auth/otp/verify', {
      phone,
      code: latestCode(app, phone),
      purpose: 'sign_in',
      device: DEVICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionBody>().user.id).toBe(session.user.id);
  });

  it('§8.4 sign in with email or phone + password; status first; wrong → counted; locked → time left; success clears', async () => {
    const { email, password, session } = await legacyUser(app, client);
    const status = await get(`/v1/auth/lockout-status?email=${encodeURIComponent(email)}`, {});
    expect(status.json()).toEqual({ locked: false, locked_until: null, failed_attempts: 0 });
    const wrong = await post(app, '/v1/auth/login', {
      email,
      password: 'Wrong1234',
      device: DEVICE,
    });
    expect(errorOf(wrong)).toMatchObject({
      code: 'auth:invalid_credentials',
      details: { failed_attempts: 1 },
    });
    const ok = await post(app, '/v1/auth/login', {
      phone: session.user.phone,
      password,
      device: DEVICE,
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (await get(`/v1/auth/lockout-status?email=${encodeURIComponent(email)}`, {})).json(),
    ).toEqual({
      locked: false,
      locked_until: null,
      failed_attempts: 0,
    });
    for (let i = 0; i < 5; i += 1)
      await post(app, '/v1/auth/login', { email, password: 'Wrong1234', device: DEVICE });
    const locked = await post(app, '/v1/auth/login', { email, password, device: DEVICE });
    expect([locked.statusCode, errorOf(locked).code]).toEqual([423, 'login_lockout:locked']);
    expect(errorOf(locked).details).toMatchObject({ locked: true, failed_attempts: 5 });
  });

  it('§8.5 Google / Apple: Apple answers 503 auth:provider_disabled (the app shows "not available yet")', async () => {
    const res = await post(app, '/v1/auth/oauth/apple', { id_token: 'x', device: DEVICE });
    expect([res.statusCode, errorOf(res).code]).toEqual([503, 'auth:provider_disabled']);
    // Google with a fake JWKS: test/int/auth-oauth.int-spec.ts (no client ids here → disabled).
    const google = await post(app, '/v1/auth/oauth/google', { id_token: 'x', device: DEVICE });
    expect(errorOf(google).code).toBe('auth:provider_disabled');
  });

  it('§8.6 password reset: recovery link → new password → session, failures cleared', async () => {
    const { email, session } = await legacyUser(app, client);
    await post(app, '/v1/auth/login', { email, password: 'Wrong1234', device: DEVICE });
    expect((await post(app, '/v1/auth/password/forgot', { email })).statusCode).toBe(202);
    const link = latestLink(app, email)!;
    expect(link.type).toBe('recovery');
    const res = await post(app, '/v1/auth/password/reset', {
      token: link.token,
      new_password: `${GOOD_PASSWORD}Z`,
      device: DEVICE,
    });
    expect(res.statusCode).toBe(200);
    expect((await get('/v1/me', bearer(session))).statusCode).toBe(401);
    const { rows } = await client.query('select 1 from public.login_lockouts where email = $1', [
      email,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('§8.7 sign out: global (every session), and this device only with its push token cleared', async () => {
    const { email, password, session } = await legacyUser(app, client);
    const second = (
      await post(app, '/v1/auth/login', { email, password, device: DEVICE })
    ).json<SessionBody>();
    const installation = randomUUID();
    await app.inject({
      method: 'PUT',
      url: '/v1/me/devices/current',
      headers: {
        ...bearer(second),
        'x-atlas-installation-id': installation,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        platform: 'android',
        app_version: '1',
        push_provider: 'fcm',
        push_token: fakePushToken('flow'),
      }),
    });
    expect((await post(app, '/v1/auth/logout', {}, bearer(second))).statusCode).toBe(204);
    const { rows } = await client.query<{ push_token: string | null }>(
      'select push_token from public.user_devices where installation_id = $1',
      [installation],
    );
    expect(rows[0].push_token).toBeNull();
    expect((await get('/v1/me', bearer(session))).statusCode).toBe(200);
    expect((await post(app, '/v1/auth/logout-all', {}, bearer(session))).statusCode).toBe(204);
    expect((await get('/v1/me', bearer(session))).statusCode).toBe(401);
  });

  it('§8.8 session expiry: an expired or revoked access token → <fn>:not_authenticated; refresh then fails → sign in', async () => {
    const { session } = await legacyUser(app, client);
    const expired = await app.inject({
      method: 'GET',
      url: '/v1/me/incidents/open',
      headers: await authHeader(session.user.id, { expiresInSeconds: -120 }),
    });
    expect(errorOf(expired).code).toBe('get_my_open_incident:not_authenticated');
    const refreshed = (
      await post(app, '/v1/auth/refresh', { refresh_token: session.refresh_token })
    ).json<SessionBody>();
    expect((await get('/v1/me/incidents/open', bearer(refreshed))).statusCode).toBe(200);
    await post(app, '/v1/auth/logout', {}, bearer(refreshed));
    const after = await get('/v1/me/incidents/open', bearer(refreshed));
    expect(errorOf(after).code).toBe('get_my_open_incident:not_authenticated');
    const refreshAgain = await post(app, '/v1/auth/refresh', {
      refresh_token: refreshed.refresh_token,
    });
    expect(errorOf(refreshAgain).code).toBe('auth:session_expired');
  });
});
