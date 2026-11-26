# Atlas API runbook (API-100-60)

Written 2026-11-22 at stage 7.8. It records the single switch of the app to the API as it was done,
the operational routine from now on, and the checklist of what is still open before going live.

**Story 60 and D13.** API-100-60 originally asked for a per-area runbook (`docs/cutover.md`: one switch
and one rollback to the Supabase path per area). Decision D13 (2026-11-19) replaced that with **one
switch of the whole app at the end** and no Supabase fallback in the app, so AC1's per-area entries
(per-area preconditions, per-area app builds, per-area rollback to the Supabase path, per-area dates)
are **superseded by D13**. This file covers the single switch instead, as the story's D13 note asks.
The per-area switch of `docs/phase1_handoff.md` §5 and the `app_config` row
`client_incidents_backend` (migration 0004) stay unused.

No secrets in this file: environment variable names only. Values live in `api/.env` on the laptop
(staging) and later in the production host's secret store.

## 1. The switch as performed

| Stage | What was done | When / evidence |
| --- | --- | --- |
| Preconditions | Every phase gate passed and approved by Dawit (Phases 0-6: parity 267/267, gates of stories 23, 33, 38, 43, 49, 59). | Phases pushed and approved before 2026-11-21 |
| 7.1 API pre-step | FK repoint to `users` (0010, D37), A16 change password (D38), A18 change phone (D39), Supabase tokens off by default (D40). | api `2727497`, 2026-11-21 |
| 7.2 Staging | With Dawit's OK: API migrations 0005-0011 applied to `atlas_staging` (`npm run db:migrate -- --allow-remote`); `api/.env` pointed at staging (database, Storage key, own signing keys from `npm run auth:keygen`, Google client ids, fake email/SMS, test mailbox on); Redis on the laptop's docker. Smoke guide 20/20 twice (sign-up + link, profile, circle, device, avatar URL, invite + accept, sign-in, refresh, sign-out; it cleans up). | 2026-11-21 |
| 7.3a-7.3d-2 App switch | The mobile app moved to the API in four steps: sign-in and sessions (7.3a), profile and photos (7.3b), circles and invites (7.3c), alerts, live location and Socket.IO realtime (7.3d-1, 7.3d-2). 7.3d-2 removed the Supabase SDK and keys from the app. Each step phone-tested over USB (`adb reverse tcp:3000 tcp:3000`) against the laptop API on staging. | Atlas `d163fbf`, `2b4eaab`, `ece36ab`, `c18ae70`, `4c2f058`; api `6b1e45c`, `09423d1` (gap 7, D41) |
| 7.4 / 7.5 Phone test and gaps | Two-device run (resident + member), numbered gap list; gaps fixed or deferred by Dawit (gap 11 `657cd6f`, gap 15 `786ea17`; 9, 10, 12, 13 and push deferred to the Jira phase; 14 decided, built with the domain). | 2026-11-22 |
| 7.6 Retire Supabase paths | Migration 0012 (D42) applied to staging with Dawit's OK: every `anon` / `authenticated` / PUBLIC table and function grant revoked, `incidents` / `incident_events` out of `supabase_realtime`, the `avatars` write policies dropped. Supabase Auth on staging: sign-ups off, email and Google providers off, custom access token hook off. Checks: `/rest/v1` refused (42501), old RPCs 404, Supabase sign-up 422; smoke 20/20 twice; two-device sanity passed. | api `ad9084c`, 2026-11-22 |
| 7.7a SendGrid adapter | Built, off by default (D43); not switched on anywhere (no account or domain yet). | this stage |

**If the switch had to be undone:** there is no app fallback (D13). The database side of 7.6 can be
rolled back exactly (section 2.4), and the Supabase Auth settings re-enabled in the dashboard, but the
current app no longer contains any Supabase code: going back would mean shipping an older app build.

## 2. Operating the API

### 2.1 Processes

One build, two process types (same image, `node dist/main.js`):

| Process | Start | Needs | Health |
| --- | --- | --- | --- |
| API (HTTP + Socket.IO on `PORT`, default 3000) | `npm run build` then `node dist/main.js` (container: the image's default command) | Postgres, Redis | `GET /healthz` (process up), `GET /readyz` (db, redis, migrations, realtime, jobs) |
| Worker (BullMQ: outbox fan-out and channel sends) | the same with `WORKER=1` | Postgres, Redis | no HTTP port; watch the log for `job workers started` and `job failed, ...` |

- **Stop:** SIGTERM / Ctrl+C. Shutdown hooks close the HTTP server, sockets, the pool and Redis.
- **Laptop (staging, today):** `docker compose up -d --wait` in `api/` first (Redis; after a reboot the
  containers may be stopped), then `npm run build && node dist/main.js`. `api/.env` points at
  `atlas_staging` with `ALLOW_REMOTE_DATA_STORES=true`. A worker is only needed when a channel sends
  (all channels are on the fake / disabled today).
- **Production (later):** run the worker on its own instance (a busy worker slows the API), at least
  one API instance; every process of one environment shares `REDIS_URL`, `JOBS_QUEUE_PREFIX` and
  `REALTIME_ADAPTER_KEY`.

### 2.2 Realtime and Redis requirements

- Socket.IO, namespace `/v1/realtime`, engine path `/socket.io`, **websocket transport only** (D19): no
  sticky sessions needed, but the load balancer / proxy must pass websocket upgrades and allow
  long-lived connections (idle timeout above the client's ping interval).
- Several API instances fan out through the Redis adapter (`REALTIME_ADAPTER_KEY`, same value on every
  instance). `/readyz` fails with `realtime` when the adapter's Redis connections are down.
- Redis must run with **`maxmemory-policy noeviction`** (BullMQ queues, OTP counters and rate-limit
  windows must never be evicted). Staging and production must not share a Redis with the same prefixes.
- When Redis is down: `/readyz` 503 (`redis`, `realtime`, `jobs`); the rate limiter lets requests
  through (an SOS is never blocked by Redis); refresh still works (gap 15 proved it); realtime and
  queued sends wait until Redis is back.
- Behind a proxy set `TRUST_PROXY` (hop count or the proxy's CIDRs) so per-IP limits see the client
  address (`x-forwarded-for`); never `true` on a host reachable without the proxy.

### 2.3 Migrations

- API migrations: `db/migrations/NNNN_*.sql`, applied in order, each in its own transaction, recorded
  in `public.api_schema_migrations`. `/readyz` reports `migrations` while one is missing.
- **Local:** `npm run db:migrate` (refuses any non-local host).
- **Hosted (staging / production): only as an approved step, on Dawit's OK at that time:**
  `npm run db:migrate -- --allow-remote` with the target's `DATABASE_URL` in the environment (never
  written into the repo). Run it before starting the new build (additive migrations are safe for the
  running build).
- Never run tests, seeds or experiments against a hosted database. `db:seed` is local only.
- Current state: see `HANDOFF.md` (staging is synced after each push). Non-additive migrations:
  0012 (D42) and 0025 (D76, the old SQL backend removed). **0025 on staging:** only after Dawit
  pushes, with a backup or snapshot of `atlas_staging` first; the Supabase Auth custom access token
  hook must be off (it calls a function 0025 drops; it was switched off with 7.6).

### 2.4 Rollback of 0012 (retired Supabase paths)

`db/rollback/0012_down.sql` restores exactly what 0012 recorded in `public.api_retired_supabase_access`
(grants, publication members, the three Storage policies), drops that table and unrecords 0012. One
transaction; a second run stops at its first check. Only with Dawit's OK:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/0012_down.sql
```

Then re-enable the Supabase Auth settings in the dashboard if the old app must work again. Checks
before and after: `docs/phase7_handoff.md` §7.6 (107 privilege rows, two publication members, four
Storage policies after a rollback). Keep 0012 applied otherwise.

### 2.4b Rollback of 0025 (old SQL backend removed, D76)

`db/rollback/0025_down.sql` recreates the 69 functions, the 18 RLS policies and the
`client_incidents_backend` row exactly as they were after 0012, and unrecords 0025 (one
transaction, safe to run twice). To roll back 0012 as well, run this first. Only with Dawit's OK:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/0025_down.sql
```

The API does not need anything 0025 removed, so a rollback only matters to restore the old
database objects themselves.

### 2.5 Signing keys (`AUTH_JWT_KEYS`) rotation

Access tokens are signed with the key `AUTH_JWT_ACTIVE_KID` out of `AUTH_JWT_KEYS` (a JSON array of
JWKs; SECRET; every key's public part is published at `GET /v1/auth/.well-known/jwks.json`).

1. Make a key: `npm run -s auth:keygen -- --kid <new kid>` (prints one JWK; never paste it in chat).
2. Add it to `AUTH_JWT_KEYS` next to the old one; deploy (API instances verify both).
3. Set `AUTH_JWT_ACTIVE_KID=<new kid>`; deploy (new tokens use the new key).
4. After `AUTH_ACCESS_TOKEN_TTL_SECONDS + AUTH_JWT_CLOCK_SKEW_SECONDS` (default 15 min + 30 s), remove
   the old key; deploy.

Refresh tokens are opaque (hashed in the database) and are not affected. A leaked key: do the same
quickly and, if needed, end sessions (each user can sign out everywhere with
`POST /v1/auth/logout-all`; operators can revoke rows of `device_sessions`).

### 2.6 Other secrets and settings to rotate or check

`DATABASE_URL` (database password), `SUPABASE_STORAGE_SERVICE_KEY` (avatar uploads),
`REDIS_URL` (if it carries a password), and later `SENDGRID_API_KEY`, FCM / APNs keys, Twilio keys.
Each lives in the host's secret store; rotate by changing the value and restarting the API and worker.
The config refuses invalid combinations at startup and names the key, never the value.

### 2.7 After every deploy

1. `GET /healthz` 200 and `GET /readyz` 200 on every API instance (`failed` lists any broken check).
2. The startup log: no `error`; the `notification channels` line shows the expected
   `channels_enabled` and `adapters` (e.g. `mail=fake` until SendGrid is switched on).
3. The worker's log shows `job workers started`.
4. `api_schema_migrations` lists every file of `db/migrations/` (or `/readyz` says `migrations`).
5. A short smoke run on staging (sign-up / sign-in, profile, circle, SOS → member live → mark safe).
   On production: one test account only, cleaned up afterwards.
6. Watch for a few minutes: 5xx rate, `readiness: unavailable` lines, `job failed` lines,
   `auth email not sent` lines, Socket.IO connection errors.

### 2.8 Incident audit trail for support (SCRUM-74, D75)

Every incident event (activation, re-notify, each member's alert delivery outcome, the "not
delivered" notice, acknowledgments, responses, status updates, notes, marked safe, closure) is a row
of the append-only `public.audit_log`. Support and compliance read it through the read-only view
`public.support_incident_audit` (migration 0024). No endpoint and no admin role: only someone with
SQL access to the database (the Supabase SQL editor of `atlas_main` / `atlas_staging`, as
`postgres`). Read only: never write to `audit_log` (UPDATE, DELETE and TRUNCATE are refused anyway).

1. Find the incident, by the resident's account email (newest first):

   ```sql
   select i.id, i.status, i.emergency_type, i.activated_at, i.resolved_at, i.closed_at
     from public.incidents i
     join public.users u on u.id = i.resident_id
    where u.email = '<resident email>'
    order by i.activated_at desc
    limit 10;
   ```

   or by a time window (UTC):

   ```sql
   select id, resident_id, status, activated_at
     from public.incidents
    where activated_at between '2026-11-26 08:00+00' and '2026-11-26 10:00+00'
    order by activated_at;
   ```

2. Read its trail in time order (times are UTC):

   ```sql
   select occurred_at, action, actor_user_id, detail,
          resident_id, resident_name, circle_id, emergency_type, incident_status
     from public.support_incident_audit
    where incident_id = '<incident id>'
    order by occurred_at, audit_id;
   ```

3. The actions: `incident.created` / `incident.renotified` (activation, recipient count);
   `incident.delivery_outcome` (one per member push row: `status` sent / delivered / failed /
   skipped, `attempts`, `error_code`, e.g. `no_device`); `incident.delivery_failed_notice` (the
   resident was told a member did not receive the alert); `incident.acknowledged`;
   `incident.response_set` (`status` responding / unable); `incident.update_sent`;
   `incident.notes_set`; `incident.resolved` (marked safe); `incident.closed` (`auto_closed` true =
   closed by the sweeper after inactivity). `actor_user_id` null = the system (worker or sweeper).

The view holds ids and names only: no coordinates, notes, share payloads, phone numbers, tokens or
client IP. Retention: every row is kept (no purge) until the client's data retention policy exists
(client question C6). Cancels before sending never reach the server and are not in the trail;
location sharing start / stop is in `incident_events` (the activity feed), not in the audit log.

## 3. Going live checklist (still open)

| # | Item | Owner | Notes |
| --- | --- | --- | --- |
| 1 | Production hosting chosen and set up (API instances + worker instance, EU region near the database, D9) | Dawit / team | also story 62 AC5 "production DB plan" (D9: the Supabase project on Pro; `atlas_staging` stays and may be renamed) |
| 2 | Production database: the project on Pro, connection limits checked against `DATABASE_POOL_MAX` + 1 per process, backups | Dawit | |
| 3 | Production Redis with `noeviction`, own prefixes | team | section 2.2 |
| 4 | Domain bought; SendGrid account, domain authentication, restricted API key; `CHANNEL_EMAIL_ADAPTER=sendgrid` | Dawit | `docs/phase7_handoff.md` §7.7a, D43 |
| 5 | Gap 14: https App Links on the domain (`AUTH_LINK_BASE`, `INVITE_URL_BASE`, `assetlinks.json`, `apple-app-site-association`, store redirect, app link parser; old scheme accepted for a while) | api + mobile agents | needed for clickable email links in most mail apps |
| 6 | Push: FCM / APNs keys, `CHANNEL_PUSH_ADAPTER=real`, `CHANNEL_PUSH_ENABLED=true`; push in the app (not built yet) | Dawit + mobile agent | deferred to the Jira phase |
| 7 | Twilio hold: stays on until Dawit lifts it (`CHANNEL_SMS_TWILIO_HOLD_LIFTED`), Verify service for real OTP | Dawit | OTP is fake until then |
| 8 | Channels confirmed disabled (or real) in every deployed environment | Dawit | API-100-49 AC3, deferred to deployment |
| 9 | `TRUST_PROXY` / `x-forwarded-for` set for the production proxy | team | section 2.2 |
| 10 | CI: a deliberately red run to prove the gate blocks; deployment checks | team | HANDOFF "Still open for later" |
| 11 | Worker on its own instance | team | section 2.1 |
| 12 | The "PRODUCTION" comments in `api/.env` resolved (Dawit edits that file) | Dawit | |
| 13 | `AUTH_TEST_MAILBOX_ENABLED=false`, `OPENAPI_ENABLED` decided in production (`SUPABASE_JWT_*` no longer exist, D76) | team | the config refuses the test mailbox in production |
| 14 | ~~One release after 0012: a migration that drops the old SQL functions (story 62 AC1)~~ Done: 0025 (D76), parity retired | api agent | staging gets 0025 after Dawit's push (backup first) |
| 15 | The old prototype Supabase project deleted (Dawit) | Dawit | nothing reads it |
| 16 | Store listings (needed by the App Links fallback) | Dawit | |
