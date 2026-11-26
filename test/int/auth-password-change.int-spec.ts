import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import {
  createAuthApp,
  DEVICE,
  errorOf,
  post,
  type SessionBody,
  signedUpUser,
} from '../support/auth-api';
import { openTestClient } from '../support/database';

/**
 * Stage 7.1b, A16 `PUT /v1/auth/password` (D38): the current password, the D5a policy, a change
 * (as the reset), argon2id, every OTHER session revoked (`password_change`), audit, 10 attempts per
 * user per 15 minutes.
 */
const NEW_PASSWORD = ['Changed', 'Secret', '7x'].join('');

describe('change password while signed in (A16, stage 7.1b)', () => {
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

  const change = (headers: Record<string, string>, body: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/v1/auth/password',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const bearer = (session: SessionBody) => ({ authorization: `Bearer ${session.access_token}` });
  const me = (session: SessionBody) =>
    app.inject({ method: 'GET', url: '/v1/me', headers: bearer(session) });
  const login = (email: string, password: string) =>
    post(app, '/v1/auth/login', { email, password, device: DEVICE });

  it('401 without a token', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/auth/password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ current_password: 'x', new_password: NEW_PASSWORD }),
    });
    expect([res.statusCode, errorOf(res).code]).toEqual([401, 'auth:not_authenticated']);
  });

  it('refusals in order: body, current password, policy, same password; nothing changes', async () => {
    const { email, password, session } = await signedUpUser(app);
    const other = (await login(email, password)).json<SessionBody>();
    const cases: [unknown, number, string, string][] = [
      [{ new_password: NEW_PASSWORD }, 422, 'validation:invalid_request', 'current_password'],
      [
        { current_password: 'Wrong1234', new_password: 'weak' },
        401,
        'auth:invalid_credentials',
        'current_password',
      ],
      [
        { current_password: password, new_password: 'alllowercase1' },
        422,
        'auth:weak_password',
        'new_password',
      ],
      [{ current_password: password }, 422, 'auth:weak_password', 'new_password'],
      [
        { current_password: password, new_password: password },
        422,
        'auth:same_password',
        'new_password',
      ],
    ];
    for (const [body, status, code, field] of cases) {
      const res = await change(bearer(session), body);
      expect([res.statusCode, errorOf(res).code, errorOf(res).details.field]).toEqual([
        status,
        code,
        field,
      ]);
    }
    expect((await me(other)).statusCode).toBe(200);
    expect((await login(email, password)).statusCode).toBe(200);
  });

  it('204: the new password works, the old one fails; the other sessions are revoked, this one stays; audit', async () => {
    const { email, password, session } = await signedUpUser(app);
    const second = (await login(email, password)).json<SessionBody>();
    const third = (await login(email, password)).json<SessionBody>();
    const res = await change(bearer(session), {
      current_password: password,
      new_password: NEW_PASSWORD,
    });
    expect([res.statusCode, res.body]).toEqual([204, '']);

    expect((await me(session)).statusCode).toBe(200);
    expect((await me(second)).statusCode).toBe(401);
    expect((await me(third)).statusCode).toBe(401);
    const refreshed = await post(app, '/v1/auth/refresh', { refresh_token: second.refresh_token });
    expect([refreshed.statusCode, errorOf(refreshed).code]).toEqual([401, 'auth:session_expired']);
    const { rows: sessions } = await client.query<{ id: string; reason: string | null }>(
      `select id::text, revoke_reason as reason from public.device_sessions where user_id = $1
        order by created_at`,
      [session.user.id],
    );
    expect(sessions).toEqual([
      { id: session.session_id, reason: null },
      { id: second.session_id, reason: 'password_change' },
      { id: third.session_id, reason: 'password_change' },
    ]);
    const { rows: credential } = await client.query<{ algo: string }>(
      'select hash_algo as algo from public.user_credentials where user_id = $1',
      [session.user.id],
    );
    expect(credential).toEqual([{ algo: 'argon2id' }]);

    expect((await login(email, password)).statusCode).toBe(401);
    expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
    // The same password again is refused (it is the current one now).
    const again = await change(bearer(session), {
      current_password: NEW_PASSWORD,
      new_password: NEW_PASSWORD,
    });
    expect(errorOf(again).code).toBe('auth:same_password');

    const { rows: audit } = await client.query<{ detail: Record<string, unknown> }>(
      `select detail from public.audit_log
        where action = 'auth.password.changed' and target_id = $1`,
      [session.user.id],
    );
    expect(audit).toEqual([{ detail: { sessions_revoked: 2 } }]);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('an account without a password answers 401 auth:invalid_credentials', async () => {
    const { session } = await signedUpUser(app);
    await client.query('delete from public.user_credentials where user_id = $1', [session.user.id]);
    const res = await change(bearer(session), {
      current_password: 'Anything1',
      new_password: NEW_PASSWORD,
    });
    expect([res.statusCode, errorOf(res).code]).toEqual([401, 'auth:invalid_credentials']);
  });

  it('rate limited: the 11th attempt in 15 minutes answers 429 rate_limit:exceeded', async () => {
    const { session } = await signedUpUser(app);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push(
        (
          await change(bearer(session), {
            current_password: 'Wrong1234',
            new_password: NEW_PASSWORD,
          })
        ).statusCode,
      );
    }
    expect(statuses).toEqual([...Array<number>(10).fill(401), 429]);
    const last = await change(bearer(session), {
      current_password: 'Wrong1234',
      new_password: NEW_PASSWORD,
    });
    expect(errorOf(last).code).toBe('rate_limit:exceeded');
  });
});
