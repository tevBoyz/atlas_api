# Final parity sign-off (API-100-61)

Run on 2026-11-22 at stage 7.8, on the local docker database (PostgreSQL 17.11, Supabase image) and
Redis, from the API working tree at HEAD `ad9084c` plus stage 7.7a (uncommitted at the time of the run).
Never against `atlas_staging` or any hosted database.

## 1. Results of this run

| Check | Command | Result |
| --- | --- | --- |
| Parity suite (the 7 SQL test files, assertion by assertion) | `npm run test:parity` | **267 passed, 0 failed, 0 todo** (8 suites) |
| Phase 1 checklist (incidents, live location) | `npm run parity:report -- --phase 1` | exit 0: `scrum43_submit_emergency_alert.sql` 32/32, `scrum36_resident_incident_reads.sql` 18/18, `scrum45_closure_events.sql` 30/30, `membership_access_window.sql` 46/46 (5 deferred to Phase 2, passing there) |
| Phase 2 checklist (circles, invites) | `npm run parity:report -- --phase 2` | exit 0: `scrum28_accept_amendment.sql` 32/32, `scrum29_cancel_invite.sql` 41/41, `member_names_expired_invites.sql` 36/36 (4 deferred to API-100-36), `membership_access_window.sql` 15/15 (1 deferred) |
| Phase 3 checklist (profile setup) and "every parity file" | `npm run parity:report -- --phase 3` | exit 0: setup assertions 5/5; **every SQL assertion of every file: 244 of 244 have a plain passing test; 0 `it.todo`, 0 `skip` / `only`, 0 missing** |
| Unit tests | `npm test` | **1246 passed** (60 suites) |
| Integration tests (run twice) | `npm run test:int` | **1272 passed** (75 suites), twice in a row, no re-run needed |
| SQL baseline tests (the 7 SQL files run as SQL) | `npm run test:baseline` | **8 passed** (1 suite) |
| Baseline checksums | `npm run db:baseline:verify` | checksums OK |
| Lint, format, types, OpenAPI, build | `npm run lint`, `format:check`, `typecheck`, `openapi:check`, `build` | all exit 0; `db:migrate` on the local database: 12 files, 12 recorded, nothing pending |

The phase checklists of earlier gates (`docs/phase1_parity_checklist.md`, `phase2_...`, `phase3_...`)
are unchanged: this run regenerated all three and they are identical to the committed files except
the generated-on line (every assertion passing).

## 2. Spec §12.2 checklist

Every line is covered by passing tests in this run (integration files in `test/int/`, parity files in
`test/parity/`).

| §12.2 item | Proved by |
| --- | --- |
| Every error code returned for the same condition (same `fn:code`) | `phase1-error-codes`, `phase2-error-codes`, `phase3-error-codes` (each code of spec §7 against the SQL function), parity suites |
| Every response key present with the same type and null behaviour | the parity suites (API and SQL answers compared), `phase3-flows`, `profiles-read`, `incidents-reads` |
| Submit: one open incident under 10 concurrent submits; retry = renotify; `delivered_count`; events once | `incidents-submit`, `incidents-submit-membership-race`, parity `scrum43_submit_emergency_alert` |
| Share payload: flagged non-empty fields only; `{}` when none; frozen after submit | `incidents-submit`, parity `scrum43_submit_emergency_alert`, `profile-exposure` |
| Live location: out-of-order guard; `not_open` after mark safe; no write after close | `locations`, parity `scrum45_closure_events` |
| Mark safe: one call → 4 events exactly once; idempotent retry adds nothing | `incidents-mark-safe`, `idempotency`, parity `scrum45_closure_events` |
| Capacity: 5 trusted, owner excluded; valid pending counted; concurrent accepts / invites never exceed 5 | `circles-capacity`, `phase2-capacity-sweep`, `circles-invites-races`, `circles-membership-races`, parity `scrum28_accept_amendment` |
| Invite: 7-day expiry, lookup precedence, phone matching, claim side effects, own_circle / already_member / circle_full, accept idempotent with the accepter's name, decline frees a slot, cancel pending or expired, resend of expired re-checks capacity | `circles-invites`, `invites-lookup-preview`, `invites-accept-decline`, `invites-incoming-joined`, `invites-invitee-races`, `invites-reinvite-d41`, parity `scrum28_accept_amendment`, `scrum29_cancel_invite` |
| Member list: live profile names; owner sees `expired`; members see active rows only | `circles-members`, parity `member_names_expired_invites` |
| Visibility and the membership access window (list, details, events, counts, ack, realtime, closure recipients) | `incidents-reads`, `incidents-responder`, `incidents-events`, `incidents-delivery-counts`, `realtime-privacy`, `realtime-rooms`, `policies`, parity `membership_access_window`, `scrum36_resident_incident_reads` |
| No API path creates an active member row except accept (and the setup owner row) | `membership-activation-routes`, parity `membership_access_window` |
| Submit and mark safe within the 12 s client cap; same Idempotency-Key replays the stored response | `idempotency`, `incidents-submit`, `incidents-mark-safe`; timing: the Phase 1 load check `npm run load:incidents` |
| Lockout: 5/15/15, shared email/phone key, no extension while locked, per-IP limits, uniform answers | `auth-login` (parity with the lockout SQL functions, D30), `rate-limit` |
| Profile setup completion and deferred circle creation | `profile-setup`, `profile-setup-races`, parity `member_names_expired_invites` (setup), `membership_access_window` (L84) |
| `get_live_location_config` defaults and fallbacks | `live-location-config` |
| Realtime: members get active → resolved; unauthorized sockets cannot join | `realtime-broadcasts`, `realtime-rooms`, `realtime-gateway`, `realtime-user-rooms`, `realtime-privacy` |

## 3. Deliberate divergences from the SQL functions

| Decision | Case | Recorded in |
| --- | --- | --- |
| **D41** (approved 2026-11-21) | A person holding a FINISHED row of a circle (declined, canceled after their claim, or an expired claimed invite) can preview and accept a new invite to that circle: the API releases the finished rows first; the SQL functions still answer 409 `duplicate_membership`. | `docs/phase2_parity_checklist.md` "Deliberate divergences", `test/int/invites-reinvite-d41.int-spec.ts` (keeps the SQL answer on record) |
| **D42** (plan approved 2026-11-22) | The old Supabase paths (PostgREST tables, RPC EXECUTE, Supabase Realtime members, `avatars` write policies) are refused in the production state; the functions remain one release. Not a behaviour difference of an endpoint. | `docs/phase7_handoff.md` §7.6, `test/int/production-state.int-spec.ts` |

No SQL test assertion changed for either. Other decisions define behaviour that the SQL functions or
the spec left open (for example D3, D11, D14, D15, the Phase 5 notification records D22-D26, own auth
D27-D40); they are listed below.

## 4. Decisions D1-D43 (one line each; full text in epic §18 / spec §16)

| # | Decision |
| --- | --- |
| D1 | Baseline = the 37 Supabase migrations + 7 SQL test files, unchanged. |
| D1b | PostgreSQL 17.11 everywhere. |
| D2 | No open incident → `200 {"open_incident": null}`. |
| D3 | `recipient_ids` in event details hidden from members. |
| D4 | SOS always notifies every eligible member; preferences only govern non-emergency messages. |
| D5a | Password policy: min 8 with upper, lower and digit. |
| D5b | Sign-up never reveals an existing email. |
| D6 | Google / Apple auto-link only on a provider-verified email. |
| D7 | Refresh tokens rotate, 30-day life, 7-day idle limit. |
| D8 | One-time Supabase → API session exchange (kept, off by default since D40). |
| D9 | Production DB = the Supabase project on Pro; API in an EU region near it. |
| D10 | The existing database role for the API. |
| D11 | `actor_id` shown obscured to non-residents. |
| D12 | The prototype project is frozen; `atlas_staging` is the API's project. |
| D13 | One switch of the whole app at the end; no per-area switch, no Supabase fallback. |
| D14 | An SOS always goes through: member rows `FOR KEY SHARE` during submit. |
| D15 | Remove with a member id of another circle → 404 `remove_circle_member:not_found`. |
| D16 | Profile write validation codes and timestamps. |
| D17 | Avatars through Supabase Storage signed URLs (`AvatarStorage`). |
| D18 | Profile setup lock order. |
| D19 | Socket.IO, namespace `/v1/realtime`, websocket only, token in the handshake. |
| D20 | Incident rooms: join acks and window authorization. |
| D21 | Broadcast payloads read after commit; recipients rechecked. |
| D22 | Device registration U1 / U2 with the installation id. |
| D23 | Transactional outbox, relay and the worker process. |
| D24 | Channel adapters behind interfaces, fake by default, Twilio hold. |
| D25 | Delivery records, retries within 60 s. |
| D26 | Incident notices (push only in Epic 100). |
| D27 | Own access tokens (EdDSA / ES256, 15 min), key rotation, dual-token guard. |
| D28 | Sign-up 202 for new and existing emails, email links, test mailbox. |
| D29 | Phone OTP through a verifier (fake until the Twilio hold lifts). |
| D30 | Password sign-in with the shared lockout table. |
| D31 | Google and Apple ID-token sign-in. |
| D32 | Refresh rotation, device sessions, sign-out. |
| D33 | Password reset (forgot always 202; reset signs out other sessions). |
| D34 | User migration from Supabase Auth (`auth:migrate-users`). |
| D35 | Session exchange route. |
| D36 | Accounts created by the API before Phase 7 (finding, resolved by D37). |
| D37 | Foreign keys repointed at `users` (0010) with back-fill. |
| D38 | A16 change password while signed in. |
| D39 | A18 change phone with an OTP to the new number. |
| D40 | Supabase access tokens off by default. |
| D41 | Re-invite after a finished invite (deliberate divergence, section 3). |
| D42 | Retire the Supabase app paths (0012) with an exact rollback. |
| D43 | SendGrid email adapter, off by default (proposed for Dawit's approval). |

## 5. "No app code calls Supabase" (AC3)

Read-only search of the mobile app (`mobile/lib/`, `mobile/pubspec.yaml`, `mobile/android/`,
`mobile/ios/`; build output excluded) for `supabase`, case-insensitive, on 2026-11-22
(`grep -rniI supabase lib pubspec.yaml android ios`). 24 hits in 13 files; `pubspec.yaml` and
`pubspec.lock` have none (the Supabase SDK is gone since 7.3d-2).

| Hits | Where | What it is | Calls Supabase? |
| --- | --- | --- | --- |
| 1 | `lib/auth/deep_links.dart:1` | `kAtlasUrlScheme = 'io.supabase.atlasmobile'`: the app's own deep-link scheme | No (opens the app; the app then calls the API) |
| 2 | `lib/auth/deep_links.dart:26, 48` | doc comments describing the `login-callback` and `invite` links of that scheme | No |
| 1 | `lib/config/atlas_env.dart:6` | default login-callback link `io.supabase.atlasmobile://login-callback/` | No |
| 2 | `lib/config/atlas_env.dart:21, 22` | doc comment: the scheme stays, "Not a Supabase setting" | No |
| 1 | `lib/config/atlas_env.dart:35` | reads the env key name `SUPABASE_AUTH_REDIRECT_URL` (the redirect link, a deep link) | No (a key name; the value is the app's scheme) |
| 1 | `lib/config/atlas_env.dart:31` | doc comment "no Supabase keys" | No |
| 4 | `android/app/src/main/AndroidManifest.xml:48, 56` (2), `ios/Runner/Info.plist:33, 36` (2) | the deep-link scheme registered for Android and iOS | No |
| 12 | `lib/auth/atlas_auth.dart:37`, `lib/auth/atlas_session.dart:3, 29, 199`, `lib/auth/auth_errors.dart:97`, `lib/auth/verification_cooldown.dart:7`, `lib/location/last_known_location_store.dart:7`, `lib/location/location_onboarding_store.dart:5`, `lib/main.dart:27`, `lib/profile/api_profile_repository.dart:97, 406`, `lib/screens/missing_config_screen.dart:7` | comments that explain what replaced Supabase ("replaces the Supabase `User`", "nothing goes to Supabase any more", "Not Supabase") | No (comments only) |

**Result: no app code path calls Supabase RPCs, PostgREST tables, Supabase Realtime or Supabase Auth.**
Every hit is the deep-link scheme `io.supabase.atlasmobile` (Android manifest, iOS Info.plist, the
link parser and its default), the env key name `SUPABASE_AUTH_REDIRECT_URL`, or a comment. No finding.

Notes (by design, not findings):

- **Avatars** are still files in Supabase **Storage** (the architecture keeps Supabase as the Postgres
  host and avatar Storage, D17): the app uploads the bytes to the signed upload URL the API hands out
  (`POST /v1/me/avatar/upload-url`; "the signed URL is the permission", no Supabase key in the app) and
  shows `avatar_url` values the API returns (public `avatars` bucket). Neither is a Supabase API call
  written in the app; the URLs come from the API.
- The scheme name `io.supabase.atlasmobile` is a leftover of the prototype; it never contacts Supabase.
  It goes away with gap 14 (https App Links on Dawit's domain).
- On the server, the same paths are closed (7.6, D42): staging refuses `/rest/v1` (42501), the old
  RPCs (404) and Supabase sign-ups (422).

## 6. Sign-off

Story 61 acceptance criteria: AC1 (§12.2 ticked with tests, section 2), AC2 (all 7 SQL test files
reproduced assertion by assertion, 244/244, section 1), AC3 (no app code calls Supabase, section 5).

Signed off by Dawit: ____________________ date ____________
