# Phase 6 hand-off: own authentication (API-100-59)

Written 2026-11-21 for the mobile epic that moves the whole app to the Atlas API in one switch (D13,
epic §18). The API side of Phase 6 (stories 50-58) is built and passed its gate (evidence: the schema
test `test/int/auth-schema.int-spec.ts`, tokens and the dual-token guard
`test/int/auth-tokens.int-spec.ts`, sign-up `auth-signup`, OTP `auth-otp`, password sign-in and the
lockout parity with the SQL functions `auth-login`, Google / Apple `auth-oauth`, sessions
`auth-sessions`, reset `auth-password-reset`, the user migration `auth-user-migration`, the exchange and
token metrics `auth-exchange`, the §8 checklist `test/int/phase6-flows.int-spec.ts`, and the load check
`npm run load:auth`). In the structure of `docs/phase1_handoff.md` to `docs/phase5_handoff.md`.
Decisions D27-D36 (epic §18, spec §16) were approved by Dawit on 2026-11-21. Stage 7.1 (decisions
D37-D40, approved) amends this note: new sign-ups work end to end (D37), password change A16 (D38),
phone change A18 (D39) and Supabase tokens off by default (D40).

Nothing here changes the app today: the app keeps Supabase Auth until the single switch. Since D40 the
API accepts only its own access tokens by default (`SUPABASE_JWT_ACCEPT` is false); Supabase tokens
work only with an explicit `SUPABASE_JWT_ACCEPT=true`.

**New sign-ups work end to end (D37).** Since migration 0010 the foreign keys of `profiles.id`,
`safety_circle_members.user_id` and `user_devices.user_id` point at `public.users`, so an account made
by API sign-up or by a first Google / Apple sign-in can complete its profile, join circles and register
its devices. The app must NOT work around the old D36 limitation.

## 1. `AtlasAuth` / `SessionStore` method to API call

Every sign-in answers a **Session**: `{access_token, access_token_expires_at, refresh_token,
refresh_token_expires_at, session_id, user}` with `user` = **User** `{id, email, phone,
email_confirmed_at, phone_confirmed_at, created_at, identities: [{provider, created_at}]}`. Bodies
that open a session carry `device: {platform: "android"|"ios", app_version, device_name?}`; send the
installation id (`X-Atlas-Installation-Id`, Phase 5) as well, so sign-out clears that device's push
token. Public routes need no `Authorization`; the others take `Authorization: Bearer <access token>`.

| App step today (spec §8) | Endpoint (Dart `AuthClient`) | Body | Success | Errors (HTTP) |
| --- | --- | --- | --- | --- |
| `auth.signUp` + phone metadata (§8.1) | `POST /v1/auth/signup` (`signUp`) | `{email, password, phone, full_name, device}` | 202 `{verification: {channel: "email", expires_in_seconds: 300}}` (no session) | `auth:invalid_email`, `auth:weak_password`, `auth:invalid_phone`, `auth:invalid_full_name`, `auth:invalid_device` (422, `details.field`), `auth:over_email_send_rate_limit` (429), `rate_limit:exceeded` (429) |
| `getSessionFromUrl(link)` (§8.2) | `POST /v1/auth/email/verify` (`verifyEmail`) | `{token, device}` (the `token` of the link) | 200 Session | `auth:link_invalid` (400), `auth:link_expired` (410), `auth:invalid_device` (422), `auth:user_disabled` (403) |
| `auth.resend(signup)` / magic link fallback (§8.2) | `POST /v1/auth/email/resend` (`resendEmail`) | `{email, purpose?: "signup"\|"magic_link"}` | 202 (always) | `auth:invalid_email` (422), `auth:over_email_send_rate_limit` (429) |
| `signInWithOtp(phone)` / `resend(sms)` (§8.3) | `POST /v1/auth/otp/send`, `/resend` (`sendOtp`, `resendOtp`) | `{phone, purpose: "sign_in"\|"verify_phone"}` (`verify_phone` with the access token) | 202 `{expires_in_seconds: 600, resends_remaining}` | `auth:invalid_phone` (422), `auth:not_authenticated` (401, verify_phone), `auth:otp_resend_limit` (429), `auth:sms_unavailable` (503) |
| `verifyOTP(sms)` (§8.3) | `POST /v1/auth/otp/verify` (`verifyOtp`) | `{phone, code, purpose, device}` (`device` for sign_in) | 200 Session (sign_in) or `{user}` (verify_phone) | `auth:otp_invalid` (400, `details.attempts_remaining`), `auth:otp_expired` (410), `auth:otp_invalidated` (423), `auth:invalid_phone`, `auth:invalid_device` (422), `auth:sms_unavailable` (503) |
| `login_lockout_status` + `signInWithPassword` + `record_login_failure` + `clear_login_failures` (§8.4) | `POST /v1/auth/login` (`signInWithPassword`) | `{email \| phone, password, device}` | 200 Session | `login_lockout:identifier_exclusive` / `identifier_required` / `email_required` / `invalid_email` / `phone_required` / `invalid_phone` (422), `auth:invalid_credentials` (401, `details` = LockoutStatus), `login_lockout:locked` (423, `details` = LockoutStatus), `auth:email_not_confirmed` / `auth:phone_not_confirmed` / `auth:user_disabled` (403), `login_lockout:rate_limited` (429) |
| `login_lockout_status` (lock screen copy) | `GET /v1/auth/lockout-status?email=\|phone=` (`loginLockoutStatus`) | - | 200 LockoutStatus `{locked, locked_until, failed_attempts}` | the identifier codes above (422), `login_lockout:rate_limited` (429) |
| `signInWithIdToken(google)` (§8.5) | `POST /v1/auth/oauth/google` (`signInWithGoogle`) | `{id_token, access_token?, device}` | 200 Session + `is_new_user` | `auth:oauth_invalid_token` (401), `auth:identity_conflict` (409), `auth:provider_disabled` / `auth:provider_unavailable` (503) |
| `signInWithIdToken(apple)` (§8.5) | `POST /v1/auth/oauth/apple` (`signInWithApple`) | `{id_token, nonce?, full_name?, device}` | 200 Session + `is_new_user` | as Google; **503 `auth:provider_disabled` today** (map to "Apple Sign In is not available yet") |
| `resetPasswordForEmail` (§8.6) | `POST /v1/auth/password/forgot` (`forgotPassword`) | `{email}` | 202 (always) | `auth:invalid_email` (422), `auth:over_email_send_rate_limit` (429) |
| recovery session + `updateUser(password)` + clear (§8.6) | `POST /v1/auth/password/reset` (`resetPassword`) | `{token, new_password, device}` | 200 Session | `auth:link_invalid` (400), `auth:link_expired` (410), `auth:weak_password` / `auth:same_password` (422) |
| SDK auto refresh | `POST /v1/auth/refresh` (`refreshSession`) | `{refresh_token}` | 200 Session (NEW refresh token) | `auth:session_expired` (401), `auth:refresh_token_reused` (401) |
| `signOut(scope: global)` (§8.7, today's default) | `POST /v1/auth/logout-all` (`signOutEverywhere`) | - | 204 | `auth:not_authenticated` (401) |
| `signOut(scope: local)` (§8.7 fallback) | `POST /v1/auth/logout` (`signOut`) | - | 204 | `auth:not_authenticated` (401) |
| `auth.getUser()` / refresh user | `GET /v1/me` (`getCurrentUser`) | - | 200 User | `auth:not_authenticated` (401) |
| (new) device list in Settings | `GET /v1/me/sessions` (`listMySessions`), `DELETE /v1/me/sessions/{session_id}` (`endMySession`) | - | 200 `[{id, platform, device_name, created_at, last_seen_at, current}]` / 204 | `auth:session_not_found` (404) |
| `updateUser(password)` while signed in (A16, D38) | `PUT /v1/auth/password` (`changePassword`) | `{current_password, new_password}` | 204; the user's OTHER devices are signed out (reason `password_change`), this session keeps working | `auth:invalid_credentials` (401, `details.field: current_password`: a wrong current password, NOT a dead session, do not sign out), `validation:invalid_request` / `auth:weak_password` / `auth:same_password` (422), `rate_limit:exceeded` (429, 10 per user per 15 minutes) |
| `updateUser(phone)` (A18, D39) | `PUT /v1/me/phone` (`changePhone`) | `{phone}` | 202 `{verification: {channel: "phone", expires_in_seconds: 600, resends_remaining}}`; calling it again is the resend; a number another account holds gets the same 202 but no code | `auth:invalid_phone` (422), `auth:otp_resend_limit` (429, 4 codes per number per 15 minutes), `auth:sms_unavailable` (503), `rate_limit:exceeded` (429, per IP as the OTP routes) |
| `verifyOTP(phone_change)` (A18, D39) | `POST /v1/me/phone/verify` (`verifyPhoneChange`) | `{phone, code}` | 200 `{user}`; only now the phone changes, confirmed | `auth:invalid_phone` (422), `auth:otp_invalid` (400, `details.attempts_remaining`), `auth:otp_invalidated` (423, the 5th wrong code, until a resend), `auth:otp_expired` (410), `auth:sms_unavailable` (503), `rate_limit:exceeded` (429, per IP) |
| (not used, D40) | `POST /v1/auth/exchange` (`exchangeSupabaseSession`), bearer = the **Supabase** access token | `{device}` | 200 Session | `auth:exchange_not_allowed` (403), `auth:session_already_exchanged` (409), `auth:not_authenticated` (401) |

**Twilio hold (A18 and OTP).** Until the hold is lifted, codes come from the fake verifier (read them in
the API log or the test mailbox); real SMS needs the Twilio adapter (section 6).

**`AtlasAuth` / `SessionStore` replacement.** Store the Session in secure storage (the refresh token is
a credential). Send `access_token` on every call; refresh shortly before `access_token_expires_at` (15
minutes) or on a 401 `*:not_authenticated` (once, then sign out). **Every refresh returns a new refresh
token: replace the stored one before anything else; never send a used one again** (a used one revokes
the session: `auth:refresh_token_reused`). Serialize refreshes (one at a time per device). A session
not refreshed for 7 days ends (D7): `auth:session_expired` → the session-expired path of §8.8.
Sign-in flows map to the table above; after every sign-in call U1 (`PUT /v1/me/devices/current`).

**The switch (D8, amended by D40).** There are no Supabase sessions to exchange: on the first start of
the API build the app drops any stored Supabase session and shows Sign In. The app must not rely on
`POST /v1/auth/exchange`; it works only with an explicit `SUPABASE_JWT_ACCEPT=true`.

**Deep links (§8.9).** The scheme is kept: `io.supabase.atlasmobile://login-callback/?type=<t>&token=<x>`
with `type` = `signup` (verify the email: `POST /v1/auth/email/verify`), `magiclink` (the same call),
`recovery` (open the new-password screen, then `POST /v1/auth/password/reset` with that token). Read
`type` and `token` from the query (not the fragment). Links are single use and valid 300 s; a newer link
of the same kind replaces older ones (`auth:link_invalid`).

**Device id.** `device.platform` / `app_version` / `device_name` describe the session; the
`X-Atlas-Installation-Id` header (the Phase 5 installation UUID) on sign-in calls links the session to
that device row, and U1 called with an own access token links it too. Logout then clears that
device's push token (keep calling U2 until the switch).

**Error mapping for the app.** `login_lockout:*` strings are unchanged (spec §7.5). New:
`auth:invalid_credentials` (was GoTrue `invalid_credentials`), `auth:email_not_confirmed` /
`auth:phone_not_confirmed` (route to verification), `auth:weak_password` (D5a: 8-128, lowercase,
uppercase, digit — the app adds the lowercase check), `auth:otp_*` (show `attempts_remaining` /
`resends_remaining`; the server now enforces rule 49), `auth:provider_disabled` (Apple: "not available
yet"), `auth:identity_conflict` (Google on an account whose email Google does not vouch for: "sign in
with your password"), `auth:session_expired` / `auth:refresh_token_reused` (the §8.8 path).

## 2. Shape changes the app must handle

| Change | What the API does | What the app should do |
| --- | --- | --- |
| Sign-up never says "already registered" (D5b, D28) | 202 the same for new and existing email (and phone) | Remove `user_already_exists` mapping; always show "check your email". |
| One call per sign-in | `POST /v1/auth/login` does status + sign-in + failure + clear | Drop the separate lockout RPC calls; keep `GET /v1/auth/lockout-status` for the lock screen. |
| Failures carry the status | 401 `details` = LockoutStatus; the 5th failure answers 423 | Show "N attempts left" / the lock time from `details`. |
| OTP limits on the server | counters per number in Redis | Remove the SharedPreferences limit logic; show the server's numbers. |
| Phone OTP for any account number | `sign_in` sends only to a number of an account; no account is created by OTP | Phone sign-up still goes through `POST /v1/auth/signup`. |
| A taken phone at sign-up | kept in `metadata.signup_phone`, not on the account | Offer "verify phone": A18 is built (stage 7.1c, D39), `PUT /v1/me/phone` then `POST /v1/me/phone/verify`. |
| Refresh rotation is strict | no 10 s reuse grace (Supabase had one) | Never retry a refresh with the same token after a timeout; sign out on `auth:refresh_token_reused` (D32). |
| Password reset | every other session is revoked (D33) | Tell the user other devices are signed out. |

## 3. Client timeouts and measured latency

Suggested caps: sign-in, sign-up, verify, reset, exchange 15 s; refresh 10 s; logout 10 s (never
blocks local sign-out); Google / Apple: within the existing 30 s social cap (the API's JWKS fetch has a
5 s timeout). Measured (section 4, 100 users at once on one laptop): sign-up p99 1100 ms, verify
288 ms, login 1043 ms, refresh 262 ms. Argon2id (19 MiB, 2 passes) is the main cost of sign-up and
login; 100 simultaneous verifications queue on Node's 4 crypto threads.

## 4. Load check

`npm run build && npm run load:auth [-- --users 100] [--out <file.json>]` on the shared harness
(throwaway containers, the built app, throwaway signing keys generated at run time, the fake email
adapter and the test-only mailbox route, default rate limits, a client address per simulated phone).
Result of the final run on 2026-11-21: **1,120 requests, 0 unexpected statuses, 0 error log lines, row
checks ok**: 100 refresh chains of 6 tokens with exactly one unused and none revoked; 20 accounts given
12 wrong passwords at the same instant each answered exactly 4 x 401 + 8 x 423 and ended with 5
failures and one lock; 20 accounts given 4 at once ended with exactly 4 failures, unlocked (no lost
counts, no double lock).

| Route | Requests | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- |
| signup | 100 | 878.7 | 1097.3 | 1100.1 | 1102.6 |
| email verify | 100 | 178.8 | 278.0 | 287.5 | 287.6 |
| login | 100 | 1016.8 | 1027.9 | 1043.2 | 1049.4 |
| refresh (5 in a row per session) | 500 | 215.3 | 236.4 | 261.6 | 277.9 |
| login wrong x12 (lockout burst) | 240 | 1341.6 | 2538.5 | 2629.8 | 2639.8 |
| login wrong x4 (count burst) | 80 | 477.3 | 790.3 | 816.1 | 816.1 |

The lockout bursts (240 argon2 checks in one instant) are timed for correctness, not budgeted.

## 5. Auth notes

- Access tokens: EdDSA (or ES256), 15 minutes, `kid` + `typ: at+jwt`, claims `iss` (atlas-api), `aud`
  (atlas-app), `sub`, `sid`, `iat`, `exp`. Public keys: `GET /v1/auth/.well-known/jwks.json`. The app
  never needs to verify them. Signing keys come from `AUTH_JWT_KEYS` / `AUTH_JWT_ACTIVE_KID` (secret
  store only; `npm run -s auth:keygen -- --kid <kid>` makes one); rotation in `.env.example`.
- Refresh tokens are opaque (43 characters), stored only as SHA-256; 30-day lifetime, single use.
- The guard reads the session row of every own token: a revoked session (logout, reuse, reset,
  delete) is refused at once, on REST and on the realtime handshake.
- Supabase tokens are off by default (D40); they are accepted only with an explicit
  `SUPABASE_JWT_ACCEPT=true` and before `SUPABASE_JWT_ACCEPT_UNTIL`. `npm run -s auth:token-usage` shows the share of Supabase tokens per
  day (requests and distinct users); each instance also logs `token usage` every 15 minutes.

## 6. Checks before the switch

- [ ] **Choose an email provider before the switch** (D24: no real email adapter; production refuses
      `CHANNEL_EMAIL_ENABLED=true`). Without it no verification, magic-link or reset email is sent.
- [ ] **Dry run on atlas_staging reviewed by Dawit**: `npm run auth:migrate-users -- --dry-run
      --allow-remote` (counts and conflicts only); then the real run, and again right after Supabase
      sign-ups are closed (accounts created later move just in time at sign-in anyway).
- [x] **Foreign keys repointed** (D36, done by D37: migration 0010, stage 7.1a): `profiles.id`,
      `safety_circle_members.user_id` and `user_devices.user_id` point at `users`, so new sign-ups and
      first Google/Apple sign-ins write their profile, circle and device rows.
- [ ] Signing keys in the host's secret store (`AUTH_JWT_KEYS`, `AUTH_JWT_ACTIVE_KID`; production
      refuses to start without them); `AUTH_TEST_MAILBOX_ENABLED` unset (production refuses it).
- [ ] Google client ids (`GOOGLE_CLIENT_IDS`: Web, Android, iOS); Apple stays off
      (`APPLE_SIGN_IN_ENABLED` unset) until the provider is set up.
- [ ] Twilio hold: OTP codes need `CHANNEL_SMS_ENABLED=true`, the Twilio adapter (hold lifted) and
      `TWILIO_VERIFY_SERVICE_SID`; until then OTP answers 503 `auth:sms_unavailable`.
- [ ] Migrations 0008 and 0009 applied (`npm run db:migrate`).
- [ ] After the switch: nothing to set for Supabase tokens (false by default since D40; leave
      `SUPABASE_JWT_ACCEPT` unset); `auth:token-usage` should show no Supabase share; then API-100-62
      disables Supabase Auth.
- [ ] App: strict refresh handling (section 1), the D5a lowercase check, the D5b neutral sign-up copy.

## 7. Known differences from today (each decided)

| Difference | Decision |
| --- | --- |
| Sign-up answers 202 without a user object, the same for an existing email or phone. | D5b, **D28** |
| One sign-in call; failures carry the LockoutStatus; the 5th answers 423. | **D30** |
| Per-IP lockout throttles counted in Redis (sliding 5 minutes), not the SQL table (fixed window). | **D30** |
| OTP limits enforced on the server; OTP never creates an account. | **D29** |
| Google with no client ids / Apple off answer 503 `auth:provider_disabled`; key server down 503 `auth:provider_unavailable`. | **D31** |
| No refresh reuse grace; idle 7 days ends a session; reset revokes the other sessions. | D7, **D32**, **D33** |
| New sign-ups and first social sign-ins had no `auth.users` row (resolved: the foreign keys point at `users`, migration 0010). | D36, resolved by **D37** |
| `login_lockouts` stays the counter store (shared with the SQL functions and the Supabase hook during the window). | **D30** |
