# Phase 5 hand-off: notifications foundation (API-100-49)

Written 2026-11-20 for the mobile epic that moves the whole app to the Atlas API in one switch (D13,
epic §18). The API side of Phase 5 (stories 44-48) is built and passed its gate (evidence: the device
test `test/int/devices.int-spec.ts`, the outbox test `test/int/outbox.int-spec.ts`, the delivery test
`test/int/notification-deliveries.int-spec.ts`, the wiring test
`test/int/incident-notifications.int-spec.ts`, the end-to-end gate test
`test/int/notifications-e2e.int-spec.ts`, and the load check `npm run load:notifications`). There is no
per-area switch: this note is input for the single mobile epic after Phase 7, in the structure of
`docs/phase1_handoff.md` to `docs/phase4_handoff.md`. Decisions D22-D26 (epic §18, spec §16) are
proposed with this phase.

Nothing here changes how the app works today: the app has no push yet, and every channel stays
**disabled** (`CHANNEL_*_ENABLED=false`) until Dawit lifts the hold for each provider. With channels
disabled the API still records every notification it would have sent (`skipped` delivery rows), so
switching push on later (SCRUM-47) needs configuration only, no code change.

## 1. Repository method to API call

| App method (new) | Endpoint | Body (snake_case) | Extra headers | Success | Errors (HTTP) |
| --- | --- | --- | --- | --- | --- |
| `registerDevice()` (new; a device service next to `SessionStore`) | `PUT /v1/me/devices/current` (U1, `registerCurrentDevice`) | `{platform: "android"\|"ios", app_version, push_provider?: "fcm"\|"apns", push_token?}` | `Authorization: Bearer <access token>`, **`X-Atlas-Installation-Id: <UUID>`** | 200 `{device_id}` (the same id for the same user and installation) | `user_devices:not_authenticated` (401, also a valid token whose user no longer exists), `user_devices:invalid_installation_id` (422, `details.field` `x-atlas-installation-id`), `validation:invalid_request` (422, body not an object), `user_devices:invalid_platform` / `:invalid_app_version` / `:invalid_push_provider` / `:invalid_push_token` (422, `details.field` names the field, first failing field wins), `rate_limit:exceeded` (429) |
| `clearPushToken()` (new; at sign-out) | `DELETE /v1/me/devices/current/push-token` (U2, `clearCurrentDevicePushToken`) | none | `Authorization`, **`X-Atlas-Installation-Id`** | 204 (also when nothing was stored) | `user_devices:not_authenticated` (401), `user_devices:invalid_installation_id` (422) |

The generated Dart client has both (`DevicesClient.registerCurrentDevice`,
`DevicesClient.clearCurrentDevicePushToken`, models `RegisterDeviceRequest`, `DeviceRegistered`,
`DevicePlatform`, `PushProvider`).

**When to call them** (API-100-49 AC2):

1. **U1 after every sign-in** (password, OTP, Google/Apple, and the Phase 6 one-time session
   exchange), once the access token is available: `platform`, `app_version` (the app's version
   string, e.g. `1.4.0+27`), and the push token with its provider when the OS gave one.
2. **U1 again whenever the push token changes** (FCM `onTokenRefresh`, APNs re-registration) and on
   app start when the stored token differs from the last one sent (cheap; also refreshes
   `last_seen_at`). Without a token yet (permission not granted), send U1 with `platform` and
   `app_version` only: a stored token is kept when both push fields are left out.
3. **U2 at sign-out, before** the session is dropped (it needs the access token). After own auth
   (Phase 6), `POST /v1/auth/logout` also clears the token (A12); keep calling U2 until then.
4. The user turns notifications off in the OS: send U1 with `push_token: null` (clears it).

**The installation id** (`X-Atlas-Installation-Id`): a random UUID v4 the app generates **once per
install** (first launch), stores in its own local storage (`shared_preferences` / secure storage)
and sends on both calls. Not the push token, not a hardware id, not per user: it survives sign-out
and sign-in of another account on the same phone (each account gets its own device row with that
installation id). Reinstalling the app makes a new one. Send it in the 8-4-4-4-12 form.

**Push token and provider**: Android FCM token → `push_provider: "fcm"`. iOS: an FCM token (Firebase
Messaging on iOS) → `"fcm"`; a raw APNs device token (hex) → `"apns"`. Always send both together.

## 2. Shape changes the app must handle

| Change | What the API sends / expects | What the app should do |
| --- | --- | --- |
| New header | `X-Atlas-Installation-Id` on U1/U2 only. | Add it in the device service (not globally). |
| One device per token | Registering a token moves it to this installation and clears it from any other row (any account). | Nothing: re-register on every token change. Two accounts on one phone: the last one to register gets the pushes. |
| Push payload (when push is switched on, SCRUM-47) | Data keys (strings): `topic` (`incident.created`, `incident.renotified`, `incident.resolved`), `incident_id`, `emergency_type`, `resident_name`, `occurred_at` (ISO-8601 UTC). A visible title (the resident's name) and body (English, e.g. `Emergency alert: Medical`). Nothing else: no share, medical, note, location or member data (D24). | On tap, open the incident (member Incident Details) by `incident_id` and re-fetch over REST; show localized text from the data keys if the app prefers its own wording. `resident_name` can be empty. |
| Who gets a push (when switched on) | Created and re-notified: the alert's delivery rows (members active when it started, D14); closed: `closure_notified.recipient_ids`. Each recipient is checked again when the push is sent (still a member, inside the window); the resident never. Preferences `alert_push_enabled` / `alert_sms_enabled` / `alert_email_enabled` are recorded but **not enforced for an SOS** (D4). | Do not promise "no SOS pushes" when the user turns `alert_push_enabled` off (the Settings copy must match D4 until the PO decides). |
| Channels | Push only for incident notices in Epic 100 (D26). SMS (SCRUM-75 fallback) stays under the Twilio hold; email has no provider. | Nothing. |

## 3. Client timeouts and measured latency

Suggested: U1 and U2 timeout 10 s, never blocking sign-in or sign-out (fire and forget with one retry
on the next app start; U2 failing must not stop the sign-out). Neither call is on an emergency path.

Measured on the built app (section 4): `PUT /v1/me/devices/current` with 150 registrations sent
together: **p50 141.9 ms, p95 210.6 ms, p99 221.5 ms**. Submit, re-notify and mark safe stay well under
the 12 s client cap and the 2 s budget (section 4 table); the request never waits for a notification:
the outbox row is one INSERT inside the transaction and the send happens in the worker.

## 4. Load check

`npm run build && npm run load:notifications [-- --baseline-main <old build>/dist/main.js]` (about
3 minutes per stack; Docker must be running). Shared harness (`test/load/load-harness.ts`):
throwaway Postgres 17.11 and Redis containers (random ports and password; the local compose database
is not touched; removed afterwards), the built API plus **two** `WORKER=1` processes of the same
build, push enabled on the **fake** adapter (nothing leaves the processes), default retry settings
and rate limits, nothing from `.env`. 50 residents x 3 members (the Phase 1 load check's shape), one
device per member. Three SOS rounds (all 50 residents submit at the same instant, then submit again
at once = re-notify, then mark safe at once) with the workers **not yet started** (`after, workers
idle`: the request path alone; the outbox rows wait), then the workers start and drain them, then
three more rounds **while they fan out** (`after, workers busy`). With `--baseline-main` the same
rounds run first against the Phase 4 release (`6454252`, no notifications) on its own fresh stack.
It fails on any lost or duplicate outbox row or delivery, any delivery not `sent` after one attempt,
any failed request, failed job or error log line, or p99 submit at or above 2 s.

Result of the final run on 2026-11-20 (Windows laptop, Docker Desktop; API, two workers, Postgres,
Redis and the load generator on the one machine): **900 outbox rows, each published once; 2,700 of
2,700 deliveries `sent` after one attempt, 2,700 distinct provider ids, 0 duplicate targets, 0 lost;
all settled 19.7 s after the first burst; 0 failed requests, 0 failed jobs, 0 error log lines in the
API, the workers and the baseline.**

| Route | Build | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- |
| submit | before (Phase 4 build) | 376.7 | 430.1 | 446.4 | 448.8 |
| submit | after, workers idle | 379.4 | 612.7 | 653.0 | 660.5 |
| submit | after, workers busy | 524.8 | 610.4 | 630.4 | 632.8 |
| re-notify | before (Phase 4 build) | 402.8 | 476.5 | 485.9 | 491.6 |
| re-notify | after, workers idle | 405.4 | 513.0 | 528.2 | 530.3 |
| re-notify | after, workers busy | 546.7 | 756.7 | 771.3 | 774.1 |
| mark safe | before (Phase 4 build) | 378.3 | 460.1 | 468.2 | 472.5 |
| mark safe | after, workers idle | 384.4 | 485.1 | 501.0 | 505.8 |
| mark safe | after, workers busy | 549.7 | 757.6 | 797.5 | 802.9 |

Reading it: with the workers idle the request path is unchanged (p50 within 1-6 ms of the Phase 4
build on all three routes). The p95 tails move from run to run on this laptop: an earlier run of the
same scenario (before the relay got its own connection) had submit 497.8 → 501.8 ms but mark safe
475.7 → 652.7 ms, while this run has submit 430.1 → 612.7 ms and mark safe 460.1 → 485.1 ms; a
different route each time, so the spread between runs is as large as the difference.
While two workers fan out 450 deliveries per round on the **same machine and database**, p50 rises by
about 150 ms and p95 by up to 300 ms: shared CPU and database, not the request waiting (the worker's
status writes already skip the commit flush, D25, and the relay has its own connection, D23). Every
figure stays far under the 2 s budget and the 12 s client cap. Phase 1's own reference (same burst
shape, different day): submit p95 628.5 ms, mark safe p95 218.0 ms (Phase 1 marked safe after 180 s
of pings, not in a burst).

## 5. Auth notes

- U1/U2 accept the Supabase access token today (no own session needed, AC4 of API-100-44); after
  Phase 6 the API's own access token. The device row belongs to the token's `sub`.
- The installation id is not a credential and is not secret; the push token is: the API never logs,
  audits or echoes it (not even in a validation error), and the app should not log it either.
- A user deleted from Auth loses their device rows (cascade).

## 6. Checks before the switch

- [ ] **Channels stay disabled in every deployed environment** (`CHANNEL_PUSH_ENABLED`,
      `CHANNEL_SMS_ENABLED`, `CHANNEL_EMAIL_ENABLED` unset or `false`) until Dawit lifts each hold:
      **Dawit's confirmation for every deployed environment is still open (API-100-49 AC3, deferred to
      deployment).** Production refuses an enabled channel on the fake adapter and refuses
      `CHANNEL_EMAIL_ENABLED=true`; the Twilio adapter is refused unless
      `CHANNEL_SMS_TWILIO_HOLD_LIFTED=true`.
- [ ] **Run a worker** next to the API: the same image with `WORKER=1` (no HTTP port, no `/readyz`;
      watch its logs: `job workers started`, `job failed, ...`). Without a worker, outbox rows are
      published to Redis but never fanned out (nothing is lost: they wait in the queue).
- [ ] **Redis**: BullMQ needs a Redis without eviction (`maxmemory-policy noeviction`) and the same
      `REDIS_URL` / `JOBS_QUEUE_PREFIX` for the API and the worker; staging and production must not
      share a Redis with the same prefix.
- [ ] **`/readyz`** now also fails with `jobs` when the queues' Redis is down.
- [ ] **Database connections**: each API and worker process uses `DATABASE_POOL_MAX` plus one (the
      outbox relay's own connection); check the total against the hosted connection limit. Prefer
      the worker on its own instance (section 4: a busy worker on the same host slows the API).
- [ ] Migrations 0005-0007 applied (`npm run db:migrate`); `/readyz` reports `migrations` otherwise.
- [ ] Before switching push on (SCRUM-47, later): FCM/APNs keys in the host's secret store,
      `CHANNEL_PUSH_ADAPTER=real`, `CHANNEL_PUSH_ENABLED=true`; one manual end-to-end push to a test
      device.
- [ ] App: generate the installation id once, call U1 after sign-in and on token refresh, U2 at
      sign-out (section 1).

## 7. Known differences from today (each decided)

| Difference | Decision |
| --- | --- |
| New endpoints U1/U2 and the `user_devices` table (today the app registers no device). | API-100-44, **D22**. |
| API incident writes record a notification (outbox row and delivery rows) for every alert, re-notify and close; the SQL functions (today's app) do not. Until the switch nothing is sent (channels disabled: rows `skipped`). | API-100-48, **D26** (D13: the whole app moves at once). |
| Recipients are checked again when the push is sent (a member removed since is `skipped` `not_eligible`). | **D26** (as the realtime recipients, D21). |
| Notification preferences are recorded on each delivery but not enforced for SOS notices. | **D4**, **D26**. |
| Incident notices use push only (no SMS, no email) in Epic 100. | **D26** (SMS = SCRUM-75 under the Twilio hold; email: no provider). |
| `/readyz` lists the extra check `jobs`. Not visible to the app. | API-100-45 AC5, **D23**. |
| `notification_outbox.deliver_at` and `notification_deliveries.preferences` are columns not in spec §11.7. | **D23**, **D25**. |
