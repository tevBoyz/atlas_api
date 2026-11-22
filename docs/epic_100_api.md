# Epic 100 — Atlas API (directions for the API agent)

> **Decisions in §18 override any alternatives still listed in individual stories** (resolved 2026-11-17).

| Field | Value |
| --- | --- |
| Epic | API-100 (internal epic; not a Jira key) |
| Product owner / developer | Dawit Tefera |
| Written | 2026-11-17, against Atlas app repo commit `2f4703d` |
| Specification | `docs/api_doc.md` (cited below as **spec §n**) |
| Scope | MVP **parity** with today's Supabase backend + the shared **foundations** future epics need |

---

## 1. Purpose

Atlas is a Flutter app (Android + iOS) that today talks directly to Supabase: Supabase Auth, ~40 `SECURITY DEFINER` SQL functions (RPCs) called through PostgREST, row-level security (RLS) as the authorization layer, and Supabase Realtime. This epic replaces that with Atlas's own API, area by area, without breaking the app at any step.

When Epic 100 is done:

1. Every operation the app performs today is served by the API with **identical behaviour** (spec §7–§10).
2. Supabase is used **only** as the PostgreSQL host and as Storage for avatars.
3. The API has the foundations future features need: push/device registration, a transactional outbox with BullMQ workers and per-recipient delivery records, an incident event log, realtime rooms per incident, an audit log, and own authentication with per-device sessions.

Future product features (Epic 3 membership states, Epic 5 responder actions, Epic 6 coordination/messaging/history, Epic 7 reliability, Phase 1.1, SCRUM-21/35/39/82) are **not** built here. They are described in spec §15 so the foundations fit them, and are listed in §13 of this file.

## 2. How to use this epic

1. Read spec §1–§15 once before story API-100-01. The spec is the source of truth for behaviour; this file is the order of work.
2. Work the stories **in order** inside a phase. A story may start only when all its dependencies are done.
3. For each story: write a short plan → wait for Dawit's go-ahead → build → test → report (rules in §3).
4. Each phase ends with a **parity gate** story. The gate proves parity and Dawit approves the phase with its manual test guide. The app does **not** switch per phase: the whole app moves to the API once, after Phase 7 (§18 D13).
5. If a story's text and the spec disagree, the spec wins; if the spec and a SQL test (spec §14.3) disagree, the SQL test wins. Report every such case.
6. Items marked **ASK** need Dawit's answer before you build that part.

## 3. Working rules

1. **Plan before build.** Before writing code for a story, post: files/modules to add, endpoints, tables/migrations, tests, and any question. Build only after Dawit says go.
2. **Tests are required.** Unit tests for validation and policies; integration tests (Testcontainers, real Postgres + Redis) for every endpoint; **parity tests** that reproduce every assertion of the SQL test file named in the story. A story is not done with failing or skipped tests.
3. **No secrets.** Never commit, log, print or put in fixtures/docs: keys, tokens, JWTs, passwords, OTP codes, database URLs with credentials, Supabase project refs/URLs, real phone numbers or emails. `.env` files are never committed; `.env.example` lists key names only. Use fake phone numbers in tests.
4. **Never change app-visible behaviour without approval.** JSON keys, types, null behaviour, ordering, error codes (`fn:code`), HTTP semantics and timing are frozen at today's behaviour. Improvements go in the report as proposals.
5. **Backward-compatible schema changes only.** The Supabase SQL functions keep serving the app until the single switch at the end (§18 D13), on the same database. Only additive migrations (new tables, new nullable/defaulted columns, new indexes). Never rename/drop a column, change a constraint, edit an existing function/policy/trigger, or change stored enum values, unless a Phase 7 story says so and Dawit approves. Never edit the baseline migrations.
6. **Same locks as the SQL.** Writes must take the same row locks in the same order as the SQL functions (spec §12) so SQL and API writers can run side by side.
7. **Server time from the database.** Use Postgres `now()` (transaction time) for every server timestamp, as the SQL does. Timestamps written in one transaction share one value.
8. **No real sends.** Push, SMS, OTP and email channels stay disabled (fake adapters) until Dawit lifts the hold for each provider. Never message real people from tests or dev.
9. **Never test against the hosted database.** Local and CI use containers. Staging/production access only when a story says so.
10. **Report after each story:** what was built, endpoints, migrations, test counts (parity assertions covered), deviations from spec, open questions, and the next story.
11. **Git:** follow Dawit's instructions in the API repo. By default prepare the change and let Dawit commit.
12. **Do not build future features** (spec §15) even when the foundation makes it easy.

## 4. Definition of "parity"

An operation has parity when, for the same database state and caller:

1. **Request semantics** match the replaced RPC/table call (arguments, defaults, trimming, normalization).
2. **Response**: the same JSON keys, types, null behaviour and list ordering as spec §7 (the REST body is the RPC's JSON object unless the spec endpoint map, spec §11.3, defines a wrapper).
3. **Errors**: the same `fn:code` string for the same condition, in the error envelope, with the HTTP status of spec §11.2. Checks run in the same order as the SQL (first failing check wins).
4. **Side effects**: the same rows and column values written (including `incident_events`, `incident_deliveries`, trigger-maintained columns), so an SQL caller and an API caller are interchangeable on the same database.
5. **Authorization**: the same access rules, including hidden existence (`not_found` instead of 403) and the membership access window (spec rule 54).
6. **Concurrency**: the same guarantees under parallel calls (one open incident per resident; capacity never above 5; accept/invite races).
7. **Tests**: every assertion of the SQL test file(s) for that operation passes as an API integration test.

**Area parity** = every operation of the area has parity + Dawit's manual QA of that app area against the API passes.

## 5. Standard definition of done (applies to every story)

1. Acceptance criteria met and demonstrated by automated tests.
2. Lint, typecheck, unit, integration and parity suites green in CI.
3. OpenAPI regenerated and committed; Dart client builds (from API-100-12 on).
4. No secrets or personal data in code, logs, fixtures or docs.
5. Migrations (if any) are additive, numbered, re-runnable on a fresh DB after the baseline.
6. Errors use the envelope and parity codes; logs carry the request id.
7. Story report posted (rule 3.10).
8. **Gate stories only** (API-100-23, 33, 38, 43, 49, 59, and 61/62 where they change what the app calls): a hand-off note for the mobile agent in `docs/phaseN_handoff.md` (N = the phase), in the structure of `docs/phase1_handoff.md`: endpoint ↔ app repository method table with bodies, extra headers, success status codes and parity error codes (HTTP); shape changes vs the SQL; client timeouts (spec §7.8) and measured latency; auth/token notes; known differences from the SQL with the decision behind each; checks before the switch. Under D13 the note is used by the single mobile switch epic, not by a per-phase switch (decided 2026-11-19).

Per-story "Definition of done" lines below list only what is added to this standard.

## 6. Environments

| Environment | Postgres | Redis | Tokens accepted | Notes |
| --- | --- | --- | --- | --- |
| Local | Docker: Postgres image with the Supabase schemas/roles (`supabase/postgres`, same major version as the hosted project — **ASK** for the version), baseline + API migrations, seed data | Docker Redis 7 | test-signed Supabase-shaped JWTs | `docker compose up`; all channels fake |
| CI | Testcontainers, same images | Testcontainers | test-signed JWTs | no secrets needed |
| Staging | Separate database from production; host undecided (Supabase Pro project or another Postgres host) | managed Redis | staging Supabase JWKS; own tokens after Phase 6 | real providers only after Dawit lifts the holds |
| Production | Undecided (Supabase free plan pauses after ~7 idle days: needs Pro or another host) | managed Redis | production Supabase JWKS; own tokens after Phase 6 | deploy only on Dawit's instruction |

Hosting, budget and start date are undecided. Keep everything host-agnostic: one Docker image, configuration only from environment variables, no provider-specific SDKs outside adapters.

**Database baseline.** The API repo does not contain the app repo. Dawit supplies (ASK) either the 37 Supabase migration files (`20261015184500_…` to `20261117120000_member_names_and_expired_invites.sql`) and the 7 SQL test files, or a schema-only dump of the hosted database. They are stored unchanged under `db/baseline/` with checksums.

## 7. Cutover order

**One switch at the end (§18 D13, 2026-11-19).** The phases below are the **build order** of the API, not app switch points. Each gate proves parity and ends with Dawit's approval of the phase (manual Git Bash test guide) and a hand-off note (§5 item 8). When Phases 2–7 are built, the entire app moves to the API in one mobile epic (own auth, all data, Socket.IO realtime, push); then the team tests and optimises; then the remaining Jira stories are built on the API. There is no per-area switch and no Supabase fallback path in the app.

| Order | App area (Flutter store) | Phase that must pass its gate | Gate story |
| --- | --- | --- | --- |
| 1 | Incidents & live location (`IncidentStore`) | Phase 1 | API-100-23 |
| 2 | Circles & invites (`CirclesStore`) | Phase 2 | API-100-33 |
| 3 | Profile & settings (`ProfileStore`) | Phase 3 | API-100-38 |
| 4 | Realtime (incident details live view, resident counts) | Phase 4 | API-100-43 |
| 5 | Notifications (device registration) | Phase 5 | API-100-49 |
| 6 | Auth (`SessionStore` / `AtlasAuth`) | Phase 6 | API-100-59 |
| 7 | Decommission Supabase app paths | Phase 7 | API-100-61, 62 |

While the API is built, the app keeps using Supabase unchanged; the API accepts Supabase access tokens (API-100-08) so its routes can be tested with the same tokens before own auth ships (Phase 6). The SQL functions stay deployed until Phase 7: they are the parity reference for the API's tests. (The earlier per-area rollback to the Supabase path is superseded by D13: no per-area switch, no app fallback.)

## 8. Story index

| Phase | Stories |
| --- | --- |
| 0 Foundation | 01 Scaffold · 02 Config · 03 Local env + DB baseline · 04 CI · 05 Error envelope · 06 Observability · 07 Health/readiness · 08 Supabase JWT guard · 09 Policies · 10 Idempotency · 11 Rate limiting · 12 OpenAPI + Dart client · 13 Test harness · 14 Audit log |
| 1 Incidents & live location | 15 Submit · 16 Open + recent · 17 Live config + attach location · 18 Notes + renotify · 19 Mark safe · 20 Counts + acknowledge · 21 Responder list + details · 22 Incident event log · 23 Gate |
| 2 Circles & invites | 24 Own circle + capacity · 25 Member list · 26 Phone invites · 27 Link invite · 28 Resend + cancel · 29 Lookup + preview · 30 Accept + decline · 31 Incoming invites + joined circles · 32 Remove + leave + membership service · 33 Gate |
| 3 Profile & settings | 34 Read profile · 35 Profile writes · 36 Complete setup · 37 Avatars · 38 Gate |
| 4 Realtime | 39 Gateway · 40 Incident rooms + authorization · 41 Incident broadcasts · 42 User rooms · 43 Gate |
| 5 Notifications foundation | 44 Device registration · 45 Outbox + BullMQ · 46 Channel adapters · 47 Delivery records + retries · 48 Incident notification wiring · 49 Gate |
| 6 Own auth | 50 Auth schema · 51 Token service · 52 Sign-up + email verification · 53 Phone OTP · 54 Password sign-in + lockout · 55 Google + Apple · 56 Refresh + sessions + logout · 57 Password reset · 58 User migration · 59 Gate + dual-token cutover |
| 7 Cutover & decommission | 60 Per-area cutover runbook · 61 Final parity sign-off · 62 Retire Supabase app paths |

---

## 9. Phase 0 — Foundation

### API-100-01 — Repository scaffold and module layout

**User story.** As the API developer, I want a NestJS-on-Fastify project with the agreed module layout, so that every later story has a fixed place to go.

**Acceptance criteria**
1. NestJS with the Fastify adapter, TypeScript `strict`, Node LTS pinned (`engines` + `.nvmrc`).
2. Folders: `src/modules/{auth,users,profiles,circles,invites,incidents,locations,notifications,activity,config,audit}`, `src/realtime/`, `src/jobs/`, `src/common/{guards,policies,idempotency,errors}`, `src/db/`. Each module is registered and empty.
3. REST routes live under the global prefix `/v1`; health routes have no prefix.
4. Scripts: `build`, `start`, `lint`, `format`, `test`, `test:int`, `test:parity`.
5. Multi-stage `Dockerfile`, runs as non-root, starts `node dist/main.js`.
6. `.env.example` (key names only); `.gitignore` excludes `.env*` except `.env.example`.
7. `docs/api_doc.md` and `docs/epic_100_api.md` present and unchanged.

**Definition of done.** Standard. `docker build` succeeds.
**Dependencies.** none.
**Parity references.** none (foundation).
**Notes.** No business code in this story.

### API-100-02 — Typed configuration

**User story.** As the operator, I want configuration validated at startup, so that a missing or wrong setting fails fast and secrets never leak.

**Acceptance criteria**
1. A config module validates all keys at startup; on failure the process exits naming the key (never its value).
2. Keys (names only): `NODE_ENV`, `PORT`, `DATABASE_URL`, `DATABASE_POOL_MAX`, `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_JWT_JWKS_URL` and/or `SUPABASE_JWT_SECRET`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE` (default `authenticated`), `SUPABASE_STORAGE_SERVICE_KEY`, `AVATARS_BUCKET` (default `avatars`), `INVITE_URL_BASE` (default `io.supabase.atlasmobile://invite/`), `TRUST_PROXY`, `LOG_LEVEL`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `CHANNEL_PUSH_ENABLED`, `CHANNEL_SMS_ENABLED`, `CHANNEL_EMAIL_ENABLED` (all default `false`). Provider and auth keys are added by their stories.
3. There is no endpoint or log line that prints configuration values.
4. Runtime business settings stay in the `app_config` table (spec §4.8), read per request, not in env.

**Definition of done.** Standard. Unit tests for valid/missing/invalid config.
**Dependencies.** 01.
**Parity references.** none.

### API-100-03 — Local environment and database baseline

**User story.** As the API developer, I want a local Postgres that has exactly the production schema, so that every test runs against the real tables, triggers and constraints.

**Acceptance criteria**
1. `docker-compose.yml` with Postgres 17.11 (Supabase image, see §18 D1b) and Redis 7.
2. `npm run db:baseline` applies `db/baseline/` (spec §6 "Database baseline") to an empty database in filename order and verifies checksums.
3. `npm run db:migrate` applies API-owned SQL migrations from `db/migrations/` (numbered, plain SQL), tracked in table `api_schema_migrations (id text primary key, applied_at timestamptz)`.
4. Drizzle schema generated by introspection of the baselined database and committed (`src/db/schema.ts`) for: `profiles`, `safety_circles`, `safety_circle_members`, `incidents`, `incident_deliveries`, `incident_events`, `app_config`, `login_lockouts`; plus read access to `auth.users` (`id`, `email`, `phone`, `email_confirmed_at`, `phone_confirmed_at`, `created_at`).
5. `npm run db:seed` creates fake local users (rows in `auth.users` + complete profiles + one circle) with fake phone numbers; never real data.
6. The database role the API uses is documented (needs SELECT on `auth.users`, read/write on the `public` app tables, no superuser at runtime).

**Definition of done.** Standard. A fresh clone reaches a running API with seeded data in under 5 commands, documented in the repo README.
**Dependencies.** 01, 02.
**Parity references.** spec §4 (all tables); all 37 migrations.
**Notes.**
- Triggers stay authoritative: `updated_at` triggers, `enforce_safety_circle_member_capacity` (raises raw `circle_full`), `safety_circle_members_set_activated_at`. **Never pass `activated_at`** in a write: the trigger only ignores client-chosen values for the `authenticated`/`anon` roles, and the API role is neither.
- Supabase-specific objects the baseline needs (roles `anon`/`authenticated`/`service_role`/`supabase_auth_admin`, `auth.uid()`, `storage` schema, `supabase_realtime` publication) come with the Supabase image. If a plain Postgres image is used instead, add a shim and ASK first.

### API-100-04 — CI pipeline

**User story.** As the team, I want every change checked automatically, so that regressions never reach the app.

**Acceptance criteria**
1. On every push and pull request: install, lint, typecheck, unit tests, integration + parity tests (Testcontainers), Docker build.
2. Any failure fails the run.
3. Committed `openapi.json` is regenerated and diffed; a difference fails the run.
4. A secret scanner runs on the diff.
5. CI needs no real credentials.

**Definition of done.** Standard. A deliberately failing test makes CI red (shown once in the report).
**Dependencies.** 01, 03.
**Parity references.** none.

### API-100-05 — Error envelope and parity error codes

**User story.** As the app, I want errors in one shape with today's `fn:code` strings, so that my existing error matching keeps working.

**Acceptance criteria**
1. Every non-2xx body is `{"error": {"code": "<fn:code>", "message": "<text>", "details": {}}}`.
2. Domain errors are raised with a code from spec §7 and mapped to HTTP by the central table in spec §11.2.
3. The raw trigger message `circle_full` (no prefix) is mapped to `<fn>:circle_full` for the operation that caused it.
4. Request validation failures return 422 with the operation's parity code when one exists (for example `attach_incident_location:invalid_source`), otherwise `validation:invalid_request` with `details.field`.
5. Unexpected errors return 500 `internal:error` without stack traces or SQL; the log entry has the request id.
6. `message` is English, plain, with no personal data.

**Definition of done.** Standard. Unit test for every mapping row of spec §11.2.
**Dependencies.** 01.
**Parity references.** spec §7 (all error codes), §11.2.

### API-100-06 — Observability

**User story.** As the operator, I want structured logs, traces and error reports without personal data, so that I can debug incidents safely.

**Acceptance criteria**
1. pino JSON logs; every request has an id (incoming `x-request-id` or generated), returned in the response header and present in every log line of the request.
2. Redaction: `authorization`, cookies, tokens, passwords, OTP codes, `share_payload`, medical/emergency fields, emails and phone numbers (masked), coordinates (omitted).
3. OpenTelemetry tracing for HTTP, Postgres, Redis and BullMQ, exporter configurable, off when no endpoint is set.
4. Sentry for unhandled errors with the same scrubbing; release = git commit.
5. Request duration logged per route.

**Definition of done.** Standard. Test proving a request with a token and a phone number logs neither.
**Dependencies.** 01, 02.
**Parity references.** none.

### API-100-07 — Health and readiness

**User story.** As the platform, I want liveness and readiness endpoints, so that deploys and load balancers know when the API can serve.

**Acceptance criteria**
1. `GET /healthz` → 200 `{"status":"ok"}`, no dependency checks.
2. `GET /readyz` → 200 when a DB query, a Redis PING and the migration check pass; else 503 `{"status":"unavailable","failed":["db"|"redis"|"migrations"]}`.
3. Both are public, not rate-limited, not logged per call at info level.

**Definition of done.** Standard.
**Dependencies.** 03.
**Parity references.** none.

### API-100-08 — Supabase JWT acceptance guard

**User story.** As a signed-in app user, I want the API to accept my current Supabase session token, so that areas can move to the API before Atlas has its own auth.

**Acceptance criteria**
1. Every route requires `Authorization: Bearer <jwt>` unless marked public (health, `GET /v1/invites/{token}/status`).
2. Verification by JWKS (`SUPABASE_JWT_JWKS_URL`, cached, refetched on unknown `kid`) or HS256 secret (`SUPABASE_JWT_SECRET`), whichever is configured; checks `exp` (clock skew ≤ 30 s, configurable), `aud` = configured audience, `role` = `authenticated`, `iss` = configured issuer.
3. `sub` (uuid) becomes the caller id. Anonymous-role tokens are rejected.
4. Missing/invalid/expired token → 401 with the **route's** parity code `<fn>:not_authenticated` (each route declares its `fn`, e.g. `POST /v1/incidents` → `submit_emergency_alert:not_authenticated`). The app maps these to "session expired".
5. The verifier is behind an interface so own tokens can be added later (API-100-51, 59).
6. Tests: valid, expired, bad signature, wrong audience, anon role, missing header, unknown `kid` refresh, malformed header.

**Definition of done.** Standard.
**Dependencies.** 02, 05.
**Parity references.** every RPC's `:not_authenticated` code (spec §7).
**Notes.** Do not require an `auth.users` or `profiles` row in the guard; each operation checks what it needs.

### API-100-09 — Authorization policy framework

**User story.** As the product owner, I want every access rule written once and tested, so that RLS can be replaced without losing a single privacy guarantee.

**Acceptance criteria**
1. Policies in `src/common/policies` with the names and rules of spec §11.4: `profile.self`, `circle.owner`, `circle.activeMember`, `circle.activeMemberSince`, `incident.resident`, `incident.memberView`, `incident.eventsView`, `incident.countsView`, `delivery.own`, `invite.recipient`, `membership.activate`.
2. `circle.activeMemberSince(circle_id, user_id, t)` = exists a `safety_circle_members` row with that circle and user, `status='active'`, `activated_at IS NOT NULL`, `activated_at <= t`; false when any argument is null.
3. Each policy is usable as a SQL predicate (for lists) and as a single-row check.
4. Incident policy failures raise the operation's `not_found` code (hidden existence).
5. Unit and integration tests, including: member activated exactly at the incident's `activated_at` → allowed; 1 microsecond later → denied; removed (row deleted) → denied; pending/declined → denied; an active member of circle A gets nothing from circle B; the resident always passes `incident.resident` for their own incidents regardless of the window.

**Definition of done.** Standard.
**Dependencies.** 03, 13 (may be built in parallel with 13 and finished after it).
**Parity references.** spec §4.5–§4.7 RLS, §6.10, rule 54; `_is_active_circle_member`, `_is_active_circle_member_since`, `_can_view_incident_events`; test `membership_access_window.sql`.

### API-100-10 — Idempotency-Key middleware

**User story.** As a resident whose phone lost the response, I want my retry to return the original result, so that I never send two alerts or two closures.

**Acceptance criteria**
1. API migration creates `idempotency_keys (user_id uuid, key text, method text, path text, request_hash text, status text check in ('in_progress','completed'), response_status int null, response_body jsonb null, created_at timestamptz default now(), expires_at timestamptz, primary key (user_id, key))`.
2. Routes opt in with a decorator: **required** on `POST /v1/incidents` and `POST /v1/incidents/{id}/mark-safe`; **optional** (honoured when sent) on invite creation routes.
3. Missing key on a required route → 400 `idempotency:key_required`; key not a UUID → 422 `idempotency:invalid_key`.
4. First use: insert `in_progress`, run the handler, store status + body, set `completed`.
5. Replay of a completed key with the same method, path and body hash → the stored status and body, header `Idempotent-Replayed: true`, no handler run.
6. Same key with a different method/path/body → 422 `idempotency:key_mismatch`.
7. Same key still `in_progress` → 409 `idempotency:in_progress` with `Retry-After: 1`. An `in_progress` row older than 60 s is treated as abandoned and the request runs again (domain idempotency protects).
8. 2xx and 4xx domain responses are stored; 5xx are not (the key can be retried).
9. Keys expire after 24 h (expired = unknown); a cleanup job or purge-on-read removes them.
10. Domain idempotency stays underneath (submit retry = re-notify; mark safe on a safe incident = no-op).

**Definition of done.** Standard. Concurrency test: two parallel requests with one key → one handler run.
**Dependencies.** 03, 05, 08.
**Parity references.** spec §11.2, rule 55.

### API-100-11 — Rate limiting

**User story.** As the operator, I want abusive traffic limited without ever blocking a real emergency, so that the service stays available.

**Acceptance criteria**
1. Redis-backed limiter with per-IP and per-user keys; 429 with `Retry-After` and code `rate_limit:exceeded` (operation-specific codes where parity defines one, e.g. `login_lockout:rate_limited` in Phase 6).
2. Configurable defaults: public invite status 60 / 5 min per IP; authenticated routes 300 / min per user; location pings 30 / min per user per incident; SOS submit and mark safe 30 / min per user (high on purpose — an SOS must never be refused by a limiter in normal use).
3. Client IP from the first `x-forwarded-for` value only when `TRUST_PROXY` is on; otherwise the socket address.
4. Health routes are never limited.

**Definition of done.** Standard.
**Dependencies.** 03, 05, 08.
**Parity references.** spec §6.8 rule 48 (lockout RPC throttles, reused in API-100-54).

### API-100-12 — OpenAPI and Dart client generation

**User story.** As the mobile developer, I want a generated Dart client from the API spec, so that the app's repository can switch to the API with typed calls.

**Acceptance criteria**
1. OpenAPI 3.1 generated from code: every request/response schema, the error envelope, bearer security, the `Idempotency-Key` header.
2. Property names are snake_case exactly as spec §7; nullable fields marked nullable; enums listed (`emergency_type`, `location_source`, statuses).
3. Stable `operationId`s (e.g. `submitEmergencyAlert`, `getMyOpenIncident`).
4. `GET /v1/openapi.json` served outside production (flag).
5. A Dart package is generated into `clients/dart/` and built in CI; version = API version.

**Definition of done.** Standard.
**Dependencies.** 01, 04, 05.
**Parity references.** spec §10.4 (JSON parsing expectations).

### API-100-13 — Test harness and SQL parity runner

**User story.** As the product owner, I want the existing SQL behaviour tests reproduced against the API, so that "parity" is proven, not assumed.

**Acceptance criteria**
1. Testcontainers start Postgres (baseline + API migrations) and Redis once per run; tests are isolated (transaction rollback or truncation).
2. Fixture builders: user (`auth.users` row + complete profile), circle with owner row, invited/accepted members (through API calls where the endpoint exists, else SQL), incident.
3. A token factory signs Supabase-shaped JWTs with a test key; the guard trusts that key in tests.
4. `npm run test:baseline` runs each original SQL test file from `db/baseline/tests/` against the container and expects it to end with its `<name>_ok` exception (proves the baseline matches).
5. `test/parity/<sql_file_name>.spec.ts` per SQL file; each SQL assertion becomes an API test whose name quotes the SQL assertion message.
6. Spec §14.3 lists the coverage of each file; the gate stories check that every listed assertion has a test.

**Definition of done.** Standard. `test:baseline` green for all 7 files.
**Dependencies.** 03, 08.
**Parity references.** all files in spec §14.3.

### API-100-14 — Audit log

**User story.** As the platform team, I want an append-only audit log of security-relevant actions, so that support and compliance questions can be answered later (foundation for SCRUM-74).

**Acceptance criteria**
1. API migration creates `audit_log` (columns per spec §11.7); the API role cannot UPDATE or DELETE it (grant or trigger).
2. `AuditService.record({action, actor_user_id, target_type, target_id, detail})` writes inside the caller's transaction, with `request_id` and IP.
3. Actions used in Epic 100: `incident.created`, `incident.renotified`, `incident.notes_set`, `incident.resolved`, `incident.acknowledged`, `circle.invite.created`, `circle.invite.resent`, `circle.invite.canceled`, `circle.invite.accepted`, `circle.invite.declined`, `circle.member.removed`, `circle.member.left`, `profile.setup_completed`, and `auth.*` (Phase 6).
4. `detail` never holds medical/share fields, tokens, full phone numbers or coordinates.
5. No read endpoint in Epic 100.

**Definition of done.** Standard.
**Dependencies.** 03.
**Parity references.** none (new). Spec §15.5 SCRUM-74.

---

## 10. Phase 1 — Incidents and live location (cutover area 1)

### API-100-15 — Submit emergency alert

**User story.** As a resident in an emergency, I want one request to create my alert (or re-notify the one already open), so that my active circle members are told at once and a retry never creates a second incident.

**Acceptance criteria**
1. `POST /v1/incidents` with body `{"emergency_type": "<type>"}` and a required `Idempotency-Key`.
2. Checks in this order: token (`submit_emergency_alert:not_authenticated`, 401) → type ∈ {`medical`, `domestic_violence`, `fire`, `burglary`, `other`} else 422 `:invalid_type` (also for null, `unspecified`, `crime_safety`, `accident`) → lock the caller's profile (`SELECT … FOR UPDATE`); none → 404 `:profile_not_found` → `profile_setup_completed_at` null → 409 `:profile_setup_incomplete`.
3. In the same transaction, select the caller's incident with status in (`activating`,`active`) `FOR UPDATE`:
   - `active` → **re-notify** (spec rule 29): `renotified_at=now()`, every delivery row of the incident `delivered_at=now()`, event `renotified {recipient_count}` (= rows refreshed), type/circle/share payload unchanged; respond **200** with `submit_outcome: "renotified"`.
   - legacy `activating` → **promote**: `status='active'`, `emergency_type`=arg, `sent_at=now()`, `share_payload`=snapshot, `cancelled_at=null`, keep `activated_at` and `circle_id`; `submit_outcome: "promoted"`, **201**.
   - none → insert `active` with `circle_id` = caller's owned circle or null, `activated_at=sent_at=now()`, `share_payload`=snapshot, using `ON CONFLICT (resident_id) WHERE status IN ('activating','active') DO NOTHING`; on conflict re-notify the open incident (200, `renotified`); else `submit_outcome: "created"`, **201**.
4. Share payload snapshot exactly per spec rules 31–32 (9 keys, flag true and value non-blank after trim; `{}` when none).
5. Created/promoted: insert one `incident_deliveries` row per circle member with `status='active'`, `user_id` not null and ≠ resident, `ON CONFLICT (incident_id, member_user_id) DO NOTHING`; events `alert_sent {recipient_count, recipient_ids (sorted ascending), emergency_type}` and `location_sharing_started {}`, each at most once per incident.
6. Response body = IncidentSend (spec §7.0: 22 keys + `delivered_count` + `acknowledged_count`) + `submit_outcome`.
7. No circle or zero active members is success with `delivered_count: 0`.
8. After commit only: write audit (`incident.created`/`incident.renotified` inside the transaction), and call the post-commit hooks used later by realtime (API-100-41) and the outbox (API-100-48). In this story the hooks are no-ops.
9. Ten parallel submits by one user with different keys → exactly one open incident, no duplicate deliveries, one `alert_sent`.
10. Latency: p99 < 2 s locally with 5 members (client cap is 12 s, spec rule 55).

**Definition of done.** Standard. Parity suite `scrum43_submit_emergency_alert` complete.
**Dependencies.** 05, 08, 09, 10, 13, 14.
**Parity references.** RPC `submit_emergency_alert` (spec §6.4, §6.5, §7.4); test `scrum43_submit_emergency_alert.sql`.
**Notes.** The SQL helper `_incident_apply_renotify` returns the refreshed row; `recipient_count` in `renotified` is the number of delivery rows refreshed (not the current member count). Members who joined after the incident started get no delivery and cannot see it (rule 54).

### API-100-16 — Open incident and recent incidents

**User story.** As a resident, I want to restore my open alert and see my recent alerts, so that the app shows the right state after a restart or a lost response.

**Acceptance criteria**
1. `GET /v1/me/incidents/open` → 200 `{"open_incident": IncidentSend | null}`; only `status='active'` rows of the caller.
2. `GET /v1/me/incidents?limit=n` → 200 array of `{id, emergency_type, status, activated_at, sent_at, resolved_at, resolved_reason}`; caller's `active`/`resolved` only; order `activated_at desc, id desc`; `limit` missing/null → 5, clamped to 1–20; legacy `cancelled`/`activating` excluded.
3. Never returns another user's incident.
4. Errors: `get_my_open_incident:not_authenticated`, `list_my_recent_incidents:not_authenticated`.
5. `GET /v1/me/incidents/open` answers in p99 < 500 ms locally (it is the 3 s recheck after a timeout).

**Definition of done.** Standard. Parity suite `scrum36_resident_incident_reads` complete.
**Dependencies.** 15.
**Parity references.** RPCs `get_my_open_incident`, `list_my_recent_incidents`; test `scrum36_resident_incident_reads.sql`.
**Notes.** The wrapper object in AC 1 is the one shape change from the RPC (which returned bare JSON `null`); the Dart client handles it. ASK if Dawit prefers the bare body.

### API-100-17 — Live location config and attach location

**User story.** As a resident with an open alert, I want my position uploaded every few seconds with old fixes ignored, so that my circle always sees my newest known location.

**Acceptance criteria**
1. `GET /v1/config/live-location` → `{interval_seconds, stale_threshold_seconds}` from `app_config` keys `live_location_interval_seconds` / `live_location_stale_threshold_seconds`; missing, non-number or ≤ 0 → 12 / 45. Any valid token. Error `get_live_location_config:not_authenticated`.
2. `POST /v1/incidents/{id}/locations` body `{location_source, location_lat?, location_lng?, location_accuracy_m?, location_captured_at?}`.
3. Validation before any lookup, in this order: source ∉ {`current`,`last_known`,`unavailable`} → 422 `attach_incident_location:invalid_source`; `unavailable` with any of lat/lng/accuracy/captured_at → 422 `:invalid_location`; `current`/`last_known` missing lat, lng or captured_at, lat ∉ [-90,90], lng ∉ [-180,180] → `:invalid_location`; `current` without accuracy → `:invalid_location`; accuracy < 0 → `:invalid_location`.
4. Lock the incident `WHERE id = $id AND resident_id = caller FOR UPDATE`; none → 404 `:not_found`; `status ≠ 'active'` or `location_sharing_ended_at` not null → 409 `:not_open`.
5. Out-of-order guard: stored and incoming `location_captured_at` both non-null and incoming < stored → no write, 200 with the current row. Equal or newer overwrite. `unavailable` (null captured_at) always overwrites (all five columns).
6. Response = IncidentShared (22 keys).
7. Never notifies, never creates deliveries, never changes status/type/notes.
8. Post-commit hook for realtime `incident.location` (no-op until API-100-41).

**Definition of done.** Standard. Late-ping-after-close assertions of `scrum45_closure_events` covered.
**Dependencies.** 15.
**Parity references.** RPCs `get_live_location_config`, `attach_incident_location` (spec §6.6, §7.4); tests `scrum45_closure_events.sql` (late attach → `not_open`, no reopen).
**Notes.** The client caps this call at 15 s and keeps one upload in flight (spec rule 63). A Redis latest-location cache is allowed only if `not_open` and the guard stay exact; the database stays the source of truth.

### API-100-18 — Live note and explicit re-notify

**User story.** As a resident, I want to set or clear a short live note on my open alert, so that responders get context (backend parity; no app UI yet).

**Acceptance criteria**
1. `PUT /v1/incidents/{id}/notes` body `{"incident_notes": string|null}`; own incident in `activating`/`active` (else 404 `set_incident_notes:not_found` for not own, 409 `:not_open` for closed).
2. Value is trimmed; empty/whitespace → null; > 250 characters after trim → 422 `:too_long`; `incident_notes_updated_at=now()` on every successful call (also when clearing).
3. Response IncidentShared. Not copied to `share_payload`.
4. `POST /v1/incidents/{id}/renotify` → same re-notify as API-100-15 AC 3 on the caller's active incident; 404 `renotify_emergency_alert:not_found`, 409 `:not_open`; response IncidentSend.
5. Post-commit realtime hooks (`incident.notes`, `incident.renotified`).

**Definition of done.** Standard.
**Dependencies.** 15.
**Parity references.** RPCs `set_incident_notes`, `renotify_emergency_alert` (spec rule 37, §7.4); `scrum45_closure_events.sql` (renotify after close → `not_open`).

### API-100-19 — Mark safe and closure events

**User story.** As a resident, I want one tap on "I'm Safe Now" to close my alert exactly once, so that my circle knows I am safe and my location stops being shared.

**Acceptance criteria**
1. `POST /v1/incidents/{id}/mark-safe` with required `Idempotency-Key`.
2. Lock the incident `FOR UPDATE`; unknown or not the caller's → 404 `mark_incident_safe:not_found`.
3. Already `resolved` with `resolved_reason='safe'` → 200 with the unchanged IncidentSend; no events, no timestamp changes.
4. Status not `active` (legacy `cancelled`, `activating`, or `resolved` with `ended`) → 409 `:not_open`.
5. From `active`, one transaction: `status='resolved'`, `resolved_at=now()`, `resolved_reason='safe'`, `auto_closed=false`, `location_sharing_ended_at=now()`; events `safe_recorded {}`, `incident_closed {resolved_reason:"safe"}`, `location_sharing_ended {}`, `closure_notified {recipient_count, recipient_ids}` each exactly once, where recipients = active members with `user_id` not null, ≠ resident, and `activated_at <= incident.activated_at` (rule 54), sorted ascending.
6. Response IncidentSend.
7. Post-commit hooks: realtime `incident.resolved`, outbox `incident.resolved`.
8. p99 < 2 s locally.

**Definition of done.** Standard. Parity suite `scrum45_closure_events` complete; window case of `membership_access_window` (closure recipients) covered.
**Dependencies.** 15, 10.
**Parity references.** RPC `mark_incident_safe` (spec §6.7, §5.6); tests `scrum45_closure_events.sql`, `membership_access_window.sql`.

### API-100-20 — Delivery counts and acknowledge

**User story.** As a resident, I want to see how many members received and acknowledged my alert; as a member, I want to acknowledge it (server parity; UI is Epic 5).

**Acceptance criteria**
1. `GET /v1/incidents/{id}/delivery-counts` → DeliveryCounts `{incident_id, delivered_count, acknowledged_count, status}`. Resident: any status. Member: status `active` and `circle.activeMemberSince`. Otherwise (including unknown id) 404 `incident_delivery_counts:not_found`.
2. `POST /v1/incidents/{id}/acknowledge`: lock the caller's delivery row `FOR UPDATE`; none → 404 `acknowledge_incident:not_found`; caller no longer an active member inside the window → 404 `:not_found`; incident not `active` → 409 `:not_open`; sets `acknowledged_at=now()` only when `delivered_at` is set and `acknowledged_at` is null; idempotent; returns DeliveryCounts.
3. Audit `incident.acknowledged` on first ack only.
4. Post-commit hook realtime `incident.delivery_counts` to the resident (API-100-41).

**Definition of done.** Standard. Window assertions for counts/ack of `membership_access_window` covered.
**Dependencies.** 15, 09.
**Parity references.** RPCs `incident_delivery_counts`, `acknowledge_incident` (spec §7.4); test `membership_access_window.sql`.
**Notes.** The app polls counts every 2 s while an alert is open, so this read must be cheap (one indexed count query).

### API-100-21 — Responder incident list and details

**User story.** As a circle member, I want to see the alerts of people whose circles I belong to, and open one, so that I can help — but never alerts from before I joined.

**Acceptance criteria**
1. `GET /v1/responder/incidents` → array of `{id, resident_name, emergency_type, activated_at, status, sent_at, renotified_at, resolved_at, resolved_reason, auto_closed}` for incidents with status `active`/`resolved`, `resident_id ≠ caller`, `circle.activeMemberSince(circle_id, caller, activated_at)`; `resident_name = coalesce(profiles.full_name, '')`; order `coalesce(resolved_at, sent_at, activated_at) desc, id asc`; no pagination; filter in SQL.
2. `GET /v1/incidents/{id}` → IncidentDetails (19 keys of spec §7.4; `share_payload` = stored object or `{}`) when status is `active`/`resolved`, caller is not the resident, `circle_id` not null and the caller is inside the window; otherwise 404 `get_incident_details:not_found` (same code for pre-join incidents).
3. Members never receive `resident_id`, `circle_id` or profile data beyond `resident_name` and `share_payload`.
4. Errors: `list_responder_incidents:not_authenticated`, `get_incident_details:not_authenticated`.

**Definition of done.** Standard. Window assertions (list, details) of `membership_access_window` covered; member-reads-closed-incident assertion of `scrum45_closure_events` covered.
**Dependencies.** 09, 15.
**Parity references.** RPCs `list_responder_incidents`, `get_incident_details` (spec §6.10, rule 54); tests `membership_access_window.sql`, `scrum45_closure_events.sql`.

### API-100-22 — Incident event log service and events read

**User story.** As the platform, I want one service that writes and reads incident events, so that today's events stay exact and future timelines/activity logs build on them.

**Acceptance criteria**
1. `IncidentEventService.record(incident_id, event_type, actor_id, detail)` inserts into `incident_events` and relies on `incident_events_once_per_incident_uidx` for once-only types (`ON CONFLICT DO NOTHING`); used by stories 15, 18, 19.
2. Known types are validated against spec §5.6; new types can be added later by migration-free code change (the column is free text) — document the list in code.
3. `GET /v1/incidents/{id}/events` → `[{id, event_type, occurred_at, actor_id, detail}]` ordered `occurred_at, id`; access `incident.eventsView` (resident, or member inside the window while `active`/`resolved`); otherwise 404 `incident_events:not_found`.
4. For non-resident callers `detail.recipient_ids` is removed from `alert_sent` and `closure_notified` (members must not learn other members' ids). ASK to confirm. Confirmed: see §18 D3. For the same callers `actor_id` is shown obscured (first 4 and last 4 hex characters kept, the rest `*`, UUID shape kept), except an actor who is the caller; the resident always sees the full id; null stays null (see §18 D11).
5. Events are never updated or deleted by the API.
6. Post-commit hook `incident.event` for realtime (API-100-41).

**Definition of done.** Standard. Event visibility assertions of `scrum45_closure_events` and `membership_access_window` covered.
**Dependencies.** 09, 15.
**Parity references.** `incident_events` table + RLS `incident_events_select_visible`, `_can_view_incident_events` (spec §4.7); tests `scrum45_closure_events.sql`, `membership_access_window.sql`.
**Notes.** The app does not read events today; this endpoint is a foundation for SCRUM-60/61/64/82 (spec §15).

### API-100-23 — Phase 1 parity gate: incidents and live location

**User story.** As the product owner, I want proof that the incident area behaves exactly like today, so that the app's IncidentStore can switch to the API.

**Acceptance criteria**
1. All assertions of `scrum43_submit_emergency_alert.sql`, `scrum36_resident_incident_reads.sql`, `scrum45_closure_events.sql` and the incident parts of `membership_access_window.sql` have passing API tests (checklist in the report, one line per assertion).
2. Every error code of spec §7.4 is produced by at least one test.
3. Mixed-writer test: an incident created through the SQL RPC can be read, located and closed through the API, and the reverse.
4. Load check: 50 concurrent residents submitting, pinging location every 12 s and marking safe; no errors, p99 submit < 2 s.
5. Hand-off note for the app: endpoint ↔ repository method table (`submitEmergencyAlert`, `getMyOpenIncident`, `listMyRecentIncidents`, `attachIncidentLocation`, `getLiveLocationConfig`, `incidentDeliveryCounts`, `markIncidentSafe`, `setIncidentNotes`, `listResponderIncidents`, `getIncidentDetails`), timeouts of spec §7.8, and the rollback switch.

**Definition of done.** Standard. Dawit's manual test guide of the incident area against the API passes; Dawit approves the phase. Hand-off note `docs/phase1_handoff.md` (§5 item 8).
**Dependencies.** 15–22.
**Parity references.** spec §12.2 checklist (incident items).

---

## 11. Phase 2 — Circles and invites (cutover area 2)

All invite/circle writes lock the `safety_circles` row first, then member rows, like the SQL. Capacity counts **active + valid pending** members, owner excluded (spec rule 8). The database capacity trigger stays as a backstop; map its raw `circle_full` to the operation's code.

### API-100-24 — Own circle and capacity

**User story.** As a circle owner, I want my circle, its members and its capacity in one call, so that My Safety Circle shows "n of 5" correctly.

**Acceptance criteria**
1. `GET /v1/me/circle/capacity` → Capacity `{limit: 5, active_count, pending_count, used, available}` where `pending_count` counts valid pending only (`status='pending'`, not canceled, not consumed, `coalesce(invite_expires_at, invited_at + 7 days) > now()`); `used = active_count + pending_count`; `available = max(0, 5 - used)`. Caller without an owned circle → 403 `circle_invite_capacity:not_owner`. No location-sharing check.
2. `GET /v1/me/circle` → `{circle: {id, owner_id, name, created_at, updated_at} | null, members: Member[] (owner view, API-100-25), capacity: Capacity | null}`; no `invite_token` anywhere.
3. A shared function `holdsSlot(row)` implements spec glossary "valid pending" and is reused by every story in this phase.

**Definition of done.** Standard. Capacity assertions of `member_names_expired_invites.sql` covered.
**Dependencies.** 09, 13.
**Parity references.** RPC `circle_invite_capacity`, helpers `_circle_invite_capacity_json`, `_circle_invite_holds_slot`; direct `safety_circles` SELECT (spec §7.8); test `member_names_expired_invites.sql`.

### API-100-25 — Circle member list with names

**User story.** As an owner or member, I want to see who is in the circle by their real names, so that I recognise everyone.

**Acceptance criteria**
1. `GET /v1/circles/{circle_id}/members`; circle id null/unknown → 404 `list_circle_members:not_found`; caller neither owner nor active member → 403 `:not_authorized`.
2. Element keys per spec §7.2: always `member_id, role, status, display_name, is_owner, invited_at, user_id, avatar_url`; owner view adds `phone, email, relationship, invite_expires_at, invite_consumed_at, invite_canceled_at`; never `invite_token`.
3. Owner sees all rows; a stored `pending` row whose lookup status is `expired` is returned with `status: "expired"`. A non-owner member sees only `status='active'` rows.
4. `display_name`: active rows with `user_id` → that user's trimmed non-empty `profiles.full_name` (read live), else the stored name; other rows → stored name.
5. `avatar_url` = public avatar URL built from config + the user's `profiles.avatar_path` (null if none or no `user_id`).
6. Order: owner first; then `active` < `pending` < `expired` < `declined`; then lower(shown name); then `invited_at`.
7. Members never receive phone, email, relationship or invite timestamps of others.

**Definition of done.** Standard. Name and visibility assertions of `member_names_expired_invites.sql` and `scrum28_accept_amendment.sql` (owner vs non-owner list) covered.
**Dependencies.** 24.
**Parity references.** RPC `list_circle_members` (latest: migration `20261117120000`); tests `member_names_expired_invites.sql`, `scrum28_accept_amendment.sql`.

### API-100-26 — Invite by phone (single and batch)

**User story.** As a circle owner, I want to invite trusted people by phone, one or several at a time, so that my circle fills up without duplicate invitations.

**Acceptance criteria**
1. Shared owner precondition (spec rule 11): profile exists (else `:profile_not_found`), `location_sharing_enabled = true` (else 409 `:location_sharing_disabled`), owned circle exists (else 404 `:circle_not_found`).
2. `POST /v1/me/circle/invites/phone` `{display_name, phone, relationship?}`: trimmed name non-empty (else 422 `invite_circle_member_by_phone:invalid_display_name`); phone trimmed and strict `^\+[1-9][0-9]{7,14}$` (else `:invalid_phone`); relationship null/blank or one of the 7 values (else `:invalid_relationship`).
3. Existing row for (circle, phone): active or consumed → 409 `:already_active`; valid pending → refresh without a new slot; expired or declined → refresh only if a slot is free (else 409 `:circle_full`). Refresh = same row, `display_name` = arg, relationship = arg or kept, `status='pending'`, `user_id=null`, new 64-hex token, `invited_at=now()`, `invite_expires_at=now()+7 days`, consumed/canceled cleared; response 200 MemberInvitePayload with `resent: true`.
4. No row: require a slot (`:circle_full`), insert pending row with token and 7-day expiry; 201 MemberInvitePayload `resent: false`. Unique clash on insert → re-read and treat as AC 3; if still not found → 409 `:duplicate_membership`.
5. `POST /v1/me/circle/invites/phone/batch` `{invites: [{phone, display_name}]}`: not an array → 422 `invite_circle_members_by_phone:invalid_invites`. One transaction, array order. Per item: not an object → `not_created {phone:null, display_name:null, reason:"invalid_invite"}`; phone normalized with the `_normalize_e164` rules (trim; keep `+E.164`; prefix `+` on 8–15 digits starting 1–9) then strict check → `invalid_phone`; blank name → `invalid_display_name`; active/consumed → `skipped already_active` (+`member_id`); valid pending → `skipped already_pending` (+`member_id`); no slot → `not_created circle_full`; expired/declined → refreshed into `created` with `resent: true`; else inserted into `created`. Response `{created, skipped, not_created, available_after}`.
6. MemberInvitePayload = `{member_id, circle_id, status, display_name, relationship, phone, invite_token, invite_url (INVITE_URL_BASE + token), invited_at, invite_expires_at, resent}`.
7. Optional `Idempotency-Key` honoured. Audit `circle.invite.created`/`resent`. No SMS is sent.

**Definition of done.** Standard. Expired-phone refresh and capacity assertions of `member_names_expired_invites.sql` covered.
**Dependencies.** 24, 10.
**Parity references.** RPCs `invite_circle_member_by_phone`, `invite_circle_members_by_phone` (latest `20261117120000`), helpers `_owner_circle_for_invite`, `_refresh_circle_invite`, `_normalize_e164`, `new_circle_invite_token`; test `member_names_expired_invites.sql`.

### API-100-27 — Shareable invite link

**User story.** As a circle owner, I want a single-use link I can share myself, so that I can invite someone whose number I do not want to type.

**Acceptance criteria**
1. `POST /v1/me/circle/invites/link` `{display_name?}`; owner precondition as API-100-26 AC 1 with prefix `create_circle_invite_link`.
2. Blank/missing name → `'Invited member'`. Requires a free slot (409 `:circle_full`).
3. Inserts a pending row with `phone=null`, token, 7-day expiry; 201 MemberInvitePayload with `phone: null`, `resent: false`.
4. Not idempotent by design (each call reserves a slot); `Idempotency-Key` honoured when sent.

**Definition of done.** Standard.
**Dependencies.** 26.
**Parity references.** RPC `create_circle_invite_link`.

### API-100-28 — Resend and cancel invitations (including expired)

**User story.** As a circle owner, I want to resend or cancel a pending or expired invitation, so that I can recover an expired invite or free its place.

**Acceptance criteria**
1. `POST /v1/me/circle/invites/{member_id}/resend`: owner precondition (prefix `resend_circle_invite`); null/unknown id or not in the caller's circle → 404 `:member_not_found`; owner row → 409 `:not_invitable`; active or consumed → 409 `:already_active`; expired or declined → needs a free slot (409 `:circle_full`, no write); valid pending → no new slot. Refresh as API-100-26 AC 3 (same `member_id`, new token; the old token then looks up as `not_found`); 200 MemberInvitePayload `resent: true`.
2. `POST /v1/me/circle/invites/{member_id}/cancel`: no location-sharing check; null/unknown → 404 `cancel_circle_invite:not_found`; caller not the circle owner → 403 `:not_authorized`; owner row → 409 `:cannot_cancel_owner`; lookup status not `pending`/`expired` → 409 `:not_pending`; writes `status='declined'`, `invite_canceled_at=now()`; 200 `{member_id, circle_id, status: "canceled", owner_name}`. The code `cancel_circle_invite:expired` is never returned.
3. `owner_name` = owner member row's stored `display_name`.
4. Audit `circle.invite.resent` / `circle.invite.canceled`.

**Definition of done.** Standard. Parity suite `scrum29_cancel_invite` complete; resend/cancel-expired assertions of `member_names_expired_invites.sql` covered.
**Dependencies.** 26.
**Parity references.** RPCs `resend_circle_invite`, `cancel_circle_invite` (latest `20261117120000`); tests `scrum29_cancel_invite.sql`, `member_names_expired_invites.sql`.

### API-100-29 — Invite lookup (public) and preview (claim)

**User story.** As someone who opened an invite link, I want to see whether it is still valid and who invited me, without exposing anyone's private data.

**Acceptance criteria**
1. `GET /v1/invites/{token}/status` — **public**, rate-limited per IP; → `{status: pending|expired|consumed|canceled|not_found, invite_expires_at|null}`; lookup precedence of spec §5.3; blank/unknown → `not_found`; never names, phones or ids.
2. `POST /v1/invites/{token}/preview` (auth) → `{status, invite_expires_at, member_id, circle_id, owner_name, invited_at, claimed, recipient_ok, owner_avatar_url}` (`claimed` is boolean or null exactly as the SQL returns: null for unclaimed rows in the `own_circle`/`canceled`/`expired` branches) with the exact status logic and key inclusion rules of spec §7.3 (`own_circle`, `already_member`, `consumed`, `canceled`, `expired`, `circle_full`, `pending`, `not_found`).
3. Recipient rule (spec rule 18): claimed row only for that user; phone invite requires the caller's normalized Auth phone (`auth.users.phone`, normalized) = row phone; link invite (phone null) → any holder.
4. Side effect: claim (`user_id=caller`) on a pending row the caller may accept (status stays `pending`); unique clash → 409 `preview_circle_invite:duplicate_membership`; owner previews never claim. Safe to repeat. Since D41 (§18) the caller's finished rows of that circle are released before the claim, so only a live row clashes.
5. `circle_full` in preview uses other active + other valid pending + 1 > 5.

**Definition of done.** Standard. Preview assertions of `scrum28_accept_amendment.sql` covered.
**Dependencies.** 24, 11.
**Parity references.** RPCs `lookup_circle_invite`, `preview_circle_invite`, helpers `_circle_invite_lookup_status`, `_circle_invite_recipient_ok`, `_auth_user_phone`; test `scrum28_accept_amendment.sql`.

### API-100-30 — Accept and decline invitations

**User story.** As an invitee, I want to accept or decline an invitation, so that I join only circles I agree to — and join under my own name.

**Acceptance criteria**
1. `POST /v1/invites/{token}/accept`: blank token → 404 `accept_circle_invite:not_found`; lock the circle row, then the member row (`FOR UPDATE`); already `active` for the caller → 200 same JSON (idempotent, no write); lookup status ≠ `pending` → `:expired` (410) / `:consumed` / `:canceled` / `:not_found`; not recipient → 403 `:not_recipient`; caller owns the circle → 409 `:own_circle`; caller already active in that circle via another row → 409 `:already_member`; other active + other valid pending + 1 > 5 → 409 `:circle_full` (no write).
2. Write: `user_id=caller`, `status='active'`, `display_name = coalesce(caller's trimmed non-empty full_name, stored display_name)`, `invite_consumed_at=now()`, `invite_canceled_at=null`; never pass `activated_at` (trigger sets it). Unique clash → 409 `:duplicate_membership` (since D41, §18, only with a live row: finished rows of the caller in that circle are released first).
3. Response 200 `{circle_id, member_id, status: "active", owner_name}`. Does not write profiles, does not need location sharing or a profile, does not create a circle for the invitee.
4. `POST /v1/invites/{token}/decline`: same lookup/recipient checks (no own-circle/capacity checks); writes `status='declined'`, `user_id=caller` (unless it clashes), `invite_canceled_at=now()`, `invite_consumed_at=null`; 200 `{circle_id, member_id, status: "declined", owner_name}`; a second decline → `:canceled`.
5. The **only** API paths that make a member row `active` are this accept and the owner row in API-100-36 (spec policy `membership.activate`). Test that no other route can.
6. Audit `circle.invite.accepted` / `declined`.

**Definition of done.** Standard. Parity suite `scrum28_accept_amendment` complete; accept-expired, name and activation assertions of `member_names_expired_invites.sql` and `membership_access_window.sql` covered.
**Dependencies.** 29, 09.
**Parity references.** RPCs `accept_circle_invite` (latest `20261117120000`), `decline_circle_invite`; trigger `safety_circle_members_set_activated_at`; tests `scrum28_accept_amendment.sql`, `member_names_expired_invites.sql`, `membership_access_window.sql`.

### API-100-31 — Incoming invitations and joined circles

**User story.** As a user, I want to see invitations sent to me and the circles I belong to, so that I can respond and find each circle.

**Acceptance criteria**
1. `GET /v1/me/invites` → array ordered `invited_at desc` of `{member_id, circle_id, status (pending|expired|canceled), owner_name, invited_at, invite_expires_at, invite_token (only when pending, else null)}`; rows where `user_id = caller`, or unclaimed rows whose normalized phone = caller's normalized Auth phone; `consumed` rows excluded. Side effect: claims pending rows the caller may accept (skips circles where the caller is already active; unique clashes swallowed).
2. `GET /v1/me/joined-circles` → array ordered `joined_at desc` of `{circle_id, name, role (owner|member), member_id, status: "active", owner_name, joined_at (= member row updated_at), active_member_count (role member + active; owner excluded)}`; **includes the caller's own circle** (parity).
3. Errors: `list_my_circle_invites:not_authenticated`, `list_my_joined_circles:not_authenticated`.

**Definition of done.** Standard.
**Dependencies.** 29, 30.
**Parity references.** RPCs `list_my_circle_invites`, `list_my_joined_circles` (spec §7.3).
**Notes.** SCRUM-81 later excludes the own circle and adds active-incident indicators (spec §15.2); not in this story.

### API-100-32 — Remove and leave, with a membership change service

**User story.** As an owner I want to remove a member, and as a member I want to leave a circle, so that access ends immediately — with one service that later Epic 3 states can extend.

**Acceptance criteria**
1. `DELETE /v1/circles/{circle_id}/members/{member_id}`: lock the member row; unknown → 404 `remove_circle_member:not_found`; caller not owner → 403 `:not_authorized`; owner row → 409 `:cannot_remove_owner`; any non-owner row (pending/active/declined) is **hard-deleted** (parity; its deliveries cascade); 200 `{member_id, circle_id, removed: true}`.
2. `POST /v1/circles/{circle_id}/leave`: null/unknown circle → 404 `leave_safety_circle:not_found`; caller owns it → 409 `:is_owner`; caller not an active member → 403 `:not_authorized`; hard-delete the caller's row; 200 `{circle_id, member_id, left: true}`.
3. Both go through `MembershipService.end(row, reason: "removed"|"left", actor)`, which (a) performs the parity write, (b) writes audit `circle.member.removed`/`left` with the member's `user_id`, and (c) calls a post-commit revocation hook (no-op until API-100-40/42 force-leave sockets).
4. After success, every incident read of that circle by that user returns 404 (test with an active incident).
5. A design note in the code/README documents how statuses `removed`/`left` (SCRUM-30/31) will replace the hard delete: additive status values, partial unique indexes limited to `pending`/`active`, kept delivery history. Not implemented here.

**Definition of done.** Standard. Removed/left assertions of `membership_access_window.sql` covered.
**Dependencies.** 25, 09, 14.
**Parity references.** RPCs `remove_circle_member`, `leave_safety_circle` (spec rule 24); test `membership_access_window.sql`.
**Notes.** Changing hard delete to stored statuses is an app-visible change and belongs to SCRUM-30/31 (spec §15.2).

### API-100-33 — Phase 2 parity gate: circles and invites

**User story.** As the product owner, I want proof that the circle and invite area behaves exactly like today, so that the app's CirclesStore can switch to the API.

**Acceptance criteria**
1. All assertions of `scrum28_accept_amendment.sql`, `scrum29_cancel_invite.sql`, `member_names_expired_invites.sql` (except the `complete_profile_setup` parts, which belong to API-100-36) and the membership parts of `membership_access_window.sql` pass as API tests (checklist).
2. Every error code of spec §7.2–§7.3 is produced by at least one test.
3. Concurrency: 6 parallel invites into a circle with 1 free slot → exactly 1 succeeds; two different users accepting the **same** invite token in parallel → exactly 1 succeeds (the other gets `accept_circle_invite:consumed`) — an accept never takes a new slot (the pending row already holds it), so that is the real contention; capacity never above 5.
4. Mixed-writer test: invites created via SQL RPC can be accepted via the API and vice versa.
5. Security test: no API route inserts or activates a member row except accept (and the setup owner row).
6. Hand-off note for the app: endpoint ↔ repository method table (`fetchOwnCircle`, `listCircleMembers`, `circleInviteCapacity`, `inviteCircleMemberByPhone`, `inviteCircleMembersByPhone`, `createCircleInviteLink`, `resendCircleInvite`, `cancelCircleInvite`, `removeCircleMember`, `lookupCircleInvite`, `previewCircleInvite`, `acceptCircleInvite`, `declineCircleInvite`, `listMyCircleInvites`, `listMyJoinedCircles`, `leaveSafetyCircle`).

**Definition of done.** Standard. Dawit's manual test guide of the circles area passes; Dawit approves the phase. Hand-off note `docs/phase2_handoff.md` (§5 item 8).
**Dependencies.** 24–32.
**Parity references.** spec §12.2 (capacity, invite, member list, visibility items).

---

## 12. Phase 3 — Profile and settings (cutover area 3)

### API-100-34 — Read own profile

**User story.** As a signed-in user, I want my full profile and setup progress, so that onboarding and Settings show my saved data.

**Acceptance criteria**
1. `GET /v1/me/profile` → Profile: every `profiles` column of spec §4.2 plus `avatar_url` (public URL or null); 404 `profiles:profile_not_found` when no row.
2. Only the caller's own row; no other user's profile is readable anywhere in the API.
3. Answers within the client's 15 s cap with margin (p99 < 500 ms locally).

**Definition of done.** Standard.
**Dependencies.** 08, 13.
**Parity references.** direct `profiles` SELECT (`fetchOwn`, `is*Complete`, spec §7.8).

### API-100-35 — Profile writes (personal, emergency, preferences, sharing, location sharing)

**User story.** As a user in onboarding or Settings, I want to save each part of my profile, so that my data and sharing choices are stored safely.

**Acceptance criteria**
1. `PUT /v1/me/profile/personal-info` `{full_name, date_of_birth (YYYY-MM-DD), gender?, avatar_path?}`: creates the row if missing; trims name (non-empty else 422 `profiles:invalid_full_name`); rejects future dates (`profiles:invalid_date_of_birth`); gender ∈ {female, male, prefer_not_to_say, null}; `avatar_path` null or under the caller's folder (`profiles:invalid_avatar_path`); server sets `personal_info_completed_at=now()` if null.
2. `PUT /v1/me/profile/emergency-info` with the fields of spec §11.3 P3: contact name/relationship/phone required; phone strict E.164; relationship and blood type from spec §5.1; notes ≤ 500 (`profiles:emergency_notes_too_long`); blank strings → null; the 9 share flags and `location_sharing_enabled` booleans; server sets `emergency_info_completed_at` if null.
3. `PUT /v1/me/profile/preferences` with the fields of spec P4: `app_language` must be `en`, `timezone` must be `Africa/Banjul`, `preferred_language` ∈ {en, wo, mnk, ff}; server sets `preferences_completed_at` if null.
4. `PATCH /v1/me/profile/sharing-flags` — any subset of the 9 flags; touches nothing else.
5. `PATCH /v1/me/profile/location-sharing` `{enabled}`.
6. Completion timestamps and `profile_setup_completed_at` are never client-writable; existing values are never reset by Settings edits.
7. Each returns the full Profile; 404 `profiles:profile_not_found` for 2–5 when no row.

**Definition of done.** Standard.
**Dependencies.** 34.
**Parity references.** direct `profiles` UPSERT/UPDATE (`upsertPersonalInfo`, `updateEmergencyInfo`, `updatePreferences`, `updateIncidentSharingFlags`, `updateLocationSharingEnabled`, spec §7.8); constraints spec §4.2.
**Notes.** Today's client writes the completion timestamps itself; moving that to the server is the decided change (spec §4.2 note). The `profiles:*` validation codes are new (no SQL equivalent): the app must map them; list them in the hand-off.

### API-100-36 — Complete profile setup (deferred circle creation)

**User story.** As a new user, I want finishing setup to create my circle and invite my emergency contact, or to wait until I turn Location Sharing on, so that my circle exists only when it can work.

**Acceptance criteria**
1. `POST /v1/me/profile/complete`; lock own profile `FOR UPDATE`; errors in order: `complete_profile_setup:not_authenticated`, `:profile_not_found` (404), `:personal_info_incomplete`, `:emergency_info_incomplete`, `:preferences_incomplete` (409) per spec rule 4.
2. `profile_setup_completed_at = coalesce(existing, now())`.
3. `location_sharing_enabled = false` → `{profile_setup_completed_at, location_sharing_enabled: false, circle_id: null, member_id: null, member_status: null}`.
4. Else, one transaction: create circle `My Safety Circle` if none; upsert owner row on `(circle_id, user_id)` (`role='owner'`, `status='active'`, `display_name=trim(full_name)`); upsert the emergency-contact row on `(circle_id, phone)` exactly per spec rule 6 (active untouched; valid pending keeps token, new 7-day expiry; declined/canceled → new token, cleared `invite_canceled_at`/`invite_consumed_at`/`user_id`); if that needs a slot and none is free, leave the row unchanged and still succeed.
5. Response `{profile_setup_completed_at, location_sharing_enabled: true, circle_id, member_id, member_status}` (`member_status` = the contact row's stored status).
6. Idempotent; audit `profile.setup_completed` once.
7. Turning Location Sharing on later (API-100-35 AC 5) followed by this call creates the circle (deferred creation, spec rules 5 and 6a).

**Definition of done.** Standard. `complete_profile_setup` assertions of `member_names_expired_invites.sql` covered.
**Dependencies.** 35, 24.
**Parity references.** RPC `complete_profile_setup` (latest `20261117120000`); test `member_names_expired_invites.sql`.

### API-100-37 — Avatars through Supabase Storage signed URLs

**User story.** As a user, I want to upload a profile photo through the API, so that the app no longer needs direct Storage access.

**Acceptance criteria**
1. `POST /v1/me/avatar/upload-url` `{content_type: image/jpeg|image/png|image/webp, content_length}` → `{upload_url, method: "PUT", headers, object_path: "{uid}/avatar-{uuid}.{ext}", expires_at}` using a Supabase Storage **signed upload URL** for bucket `avatars` (server key from config); content type outside the list → 422 `profiles:invalid_content_type`; > 5,242,880 bytes → 422 `profiles:file_too_large`.
2. `PUT /v1/me/profile/avatar` `{object_path}` or `{object_path: null}`: path must start with the caller's uid folder and exist; sets `profiles.avatar_path`; old object deleted after commit (best effort, logged).
3. `avatar_url` everywhere = public URL `{SUPABASE_URL}/storage/v1/object/public/avatars/{avatar_path}` built from config.
4. Existing paths `{uid}/avatar.{ext}` stay valid.

**Definition of done.** Standard. Storage calls behind an interface with a fake in tests.
**Dependencies.** 35, 02.
**Parity references.** Storage `avatars.uploadBinary` + `getPublicUrl` (spec §4.11, §7.8), `_avatars_public_url`, `_member_avatar_url`.

### API-100-38 — Phase 3 parity gate: profile and settings

**User story.** As the product owner, I want proof that onboarding and Settings work through the API, so that the app's ProfileStore can switch.

**Acceptance criteria**
1. Onboarding flow test: personal info → emergency info → preferences → complete → circle + owner row + contact invite exist with exact columns.
2. Deferred flow test: complete with sharing off → no circle; turn on → complete → circle created.
3. Settings edits do not change completion timestamps.
4. Avatar upload round trip with the Storage fake; URL format matches today.
5. Hand-off note: endpoint ↔ repository method table and the new `profiles:*` validation codes.

**Definition of done.** Standard. Dawit's manual test guide (onboarding + Settings) passes; Dawit approves the phase. Hand-off note `docs/phase3_handoff.md` (§5 item 8).
**Dependencies.** 34–37.
**Parity references.** spec §6.1, §12.2 (profile items).

---

## 13. Phase 4 — Realtime (cutover area 4)

### API-100-39 — Socket.IO gateway with Redis adapter

**User story.** As the platform, I want an authenticated realtime channel that scales across instances, so that live incident views do not need polling.

**Acceptance criteria**
1. Socket.IO namespace `/v1/realtime` on the same server; `@socket.io/redis-adapter` for fan-out.
2. Handshake `auth: {token}` verified with the same verifier as REST (API-100-08; own tokens later); invalid/expired → `connect_error` with code `auth:session_expired`.
3. Each socket auto-joins `user:{user_id}`.
4. Token expiry during a connection: the server disconnects the socket at `exp` (client reconnects with a fresh token).
5. Health/readiness include the adapter's Redis.

**Definition of done.** Standard. Two-instance test proves cross-instance delivery.
**Dependencies.** 08, 03.
**Parity references.** Supabase Realtime channel `incident:{id}` (spec §9).

### API-100-40 — Incident rooms with window authorization and revocation

**User story.** As a member watching an alert, I want live updates only while I am allowed to see that incident, so that privacy holds in realtime too.

**Acceptance criteria**
1. C→S `incident.join {incident_id}` → ack `{ok: true}` only for the resident or a member passing `incident.memberView` (status `active`/`resolved`, inside the window); else ack `{ok: false, error: {code: "get_incident_details:not_found"}}`.
2. C→S `incident.leave {incident_id}`.
3. Membership end (API-100-32 hook): the server removes that user's sockets from all incident rooms of that circle immediately.
4. Authorization is re-checked on every join (no cached grants).

**Definition of done.** Standard. Tests: pre-join member denied; removed member's socket stops receiving events at once.
**Dependencies.** 39, 09, 32.
**Parity references.** RLS on `incidents` for Realtime (spec §9), rule 54; test `membership_access_window.sql` (realtime is part of "nothing visible").

### API-100-41 — Incident broadcasts

**User story.** As a member and as a resident, I want incident changes pushed to me as they happen, so that locations, notes, counts and closure show without refresh.

**Acceptance criteria**
1. After commit only, the API emits to room `incident:{id}` the events of spec §11.5: `incident.updated` (16 keys the app merges today, no `resident_id`/`circle_id`), `incident.location`, `incident.notes`, `incident.renotified`, `incident.resolved`, `incident.event`; and to the resident `incident.delivery_counts` on submit/renotify/ack.
2. Every event carries `incident_id` and `occurred_at` (DB time) and, where applicable, `updated_at` so clients can drop stale events.
3. Emission is driven by the post-commit hooks added in stories 15–22.
4. A failed emit never fails the HTTP request.

**Definition of done.** Standard.
**Dependencies.** 40, 15–22.
**Parity references.** `postgres_changes` payload keys (spec §9).

### API-100-42 — User rooms: incoming incidents

**User story.** As a member with the app open, I want to be told immediately when someone in my circles raises an alert, so that I can open it (push covers the closed app later).

**Acceptance criteria**
1. On created/promoted submit, after commit, emit `incident.incoming {incident_id, resident_name, emergency_type, activated_at, sent_at}` to `user:{id}` of each delivery recipient.
2. On re-notify, emit `incident.renotified` to the same user rooms.
3. No event to users outside the window (recipients are delivery rows only).

**Definition of done.** Standard.
**Dependencies.** 41.
**Parity references.** none (today the app re-fetches `list_responder_incidents`); foundation for SCRUM-47/81/82.

### API-100-43 — Phase 4 gate: reconnect contract and realtime parity

**User story.** As the mobile developer, I want a clear reconnect contract and proof that realtime matches today, so that the app can drop `postgres_changes` and the 2-second counts poll.

**Acceptance criteria**
1. Documented contract: after any reconnect the client re-fetches over REST (open incident, counts, details) — events are not replayed.
2. Tests: member receives location/notes/resolved for an incident inside the window; pre-join, pending, removed and outsider sockets receive nothing; resident receives counts.
3. Load check: 200 sockets across 2 instances, 1 location event per 12 s per incident, no lost events in steady state.
4. Hand-off note: replace `watchIncidentRow` and counts polling; keep polling as fallback when the socket is down.

**Definition of done.** Standard. Dawit approves the phase. Hand-off note `docs/phase4_handoff.md` (§5 item 8).
**Dependencies.** 39–42.
**Parity references.** spec §9, §12.2 (realtime item).

---

## 14. Phase 5 — Notifications foundation (cutover area 5)

### API-100-44 — Device registration and push tokens

**User story.** As a user, I want my phone registered with the API, so that alerts can later reach me when the app is closed.

**Acceptance criteria**
1. API migration creates `user_devices` (spec §11.7).
2. `PUT /v1/me/devices/current` with header `X-Atlas-Installation-Id` (UUID) and `{platform, app_version, push_provider?, push_token?}` → upsert on `(user_id, installation_id)`, `last_seen_at=now()`; a push token is unique across devices (moving it clears it elsewhere); 200 `{device_id}`.
3. `DELETE /v1/me/devices/current/push-token` clears the token (used at sign-out).
4. Works with Supabase JWTs (no own sessions needed).
5. Push tokens are never logged.

**Definition of done.** Standard.
**Dependencies.** 08, 03.
**Parity references.** none (new; spec §11.3 U1/U2).

### API-100-45 — Transactional outbox and BullMQ

**User story.** As the platform, I want notifications queued only after the data is committed, so that nobody is told about an alert that was not saved.

**Acceptance criteria**
1. API migration creates `notification_outbox` (spec §11.7).
2. Domain code inserts outbox rows **in the same transaction** as the domain write; a relay publishes unpublished rows to BullMQ and sets `published_at` (at-least-once; consumers idempotent by `outbox_id`).
3. Workers run in the same image with a `WORKER=1` mode (or a separate entrypoint).
4. Delayed jobs supported (foundation for escalation, SCRUM-76).
5. Queue health in readiness; failed jobs visible in logs.

**Definition of done.** Standard. Test: rollback of the domain transaction leaves no outbox row and no job.
**Dependencies.** 03, 06.
**Parity references.** spec §11.6 ("DB write before notify").

### API-100-46 — Channel adapters behind interfaces

**User story.** As the platform, I want push, SMS and email providers behind one interface, so that providers can be swapped and stay switched off until approved.

**Acceptance criteria**
1. Interfaces `PushSender` (FCM Android, APNs iOS), `SmsSender` (Twilio), `EmailSender`; each returns `{provider_message_id, status, error_code?}`.
2. Fake adapters used by default and in tests; real adapters enabled only by `CHANNEL_*_ENABLED=true` plus their keys.
3. Push payload content limited to incident id, emergency type, resident display name and time — no share/medical data.
4. Real sends to real numbers are impossible while the Twilio hold is on (config flag defaults off; documented).

**Definition of done.** Standard.
**Dependencies.** 45, 02.
**Parity references.** none (new). Holds: SMS/Twilio, push.

**Stage 7.7a (2026-11-22, D43):** a real `EmailSender` for SendGrid (`CHANNEL_EMAIL_ADAPTER=sendgrid`), off by default (`fake`); no SendGrid account or domain yet. Switching it on: `docs/phase7_handoff.md` §7.7a.

### API-100-47 — Delivery records and retries

**User story.** As a resident, I want every notification attempt recorded with its outcome, so that later the app can show who was reached (foundation for SCRUM-65/66/67/71).

**Acceptance criteria**
1. API migration creates `notification_deliveries` (spec §11.7).
2. One row per recipient × channel × device: `queued` → `sent` → (`delivered` when a receipt exists) or `failed`; `skipped` when the channel is disabled or the user has no device.
3. Retries with exponential backoff, up to 3 retries within 60 s (configurable), then `failed` with `error_code`.
4. Invalid push tokens (provider says unregistered) are cleared from `user_devices`.
5. No read endpoint in Epic 100 (SCRUM-65 adds it).

**Definition of done.** Standard.
**Dependencies.** 45, 46, 44.
**Parity references.** none (new).

### API-100-48 — Incident notification wiring (disabled by default)

**User story.** As a member, I want alert, re-notify and closure notifications produced by the API, so that push can be switched on later without code changes.

**Acceptance criteria**
1. Submit (created/promoted/renotified) and mark safe insert outbox rows `incident.created` / `incident.renotified` / `incident.resolved` in their transactions (hooks from stories 15, 18, 19).
2. Recipients: delivery rows for created/renotified; `closure_notified.recipient_ids` for resolved (window applied).
3. With channels disabled, deliveries are recorded as `skipped`; the HTTP response time of submit/mark safe is unaffected (asynchronous).
4. Preference flags `alert_push_enabled` / `alert_sms_enabled` / `alert_email_enabled` are recorded on the delivery but **not enforced for SOS** until Dawit decides (ASK, spec §11.6).

**Definition of done.** Standard.
**Dependencies.** 47, 15, 19.
**Parity references.** none (today notifications are in-app only).

### API-100-49 — Phase 5 gate: notifications foundation

**User story.** As the product owner, I want the notification pipeline proven end to end with fakes, so that SCRUM-47 can switch on real push later.

**Acceptance criteria**
1. End-to-end test: submit → outbox → job → fake push → delivery rows `sent`; failure path → 3 retries → `failed`.
2. Device registration hand-off note for the app (call U1 after sign-in and on token refresh; U2 at sign-out).
3. Dawit confirms channels remain disabled in every deployed environment.

**Definition of done.** Standard. Dawit approves the phase. Hand-off note `docs/phase5_handoff.md` (§5 item 8).
**Dependencies.** 44–48.
**Parity references.** none.

---

## 15. Phase 6 — Own authentication (cutover area 6, last)

Rules for the whole phase: user ids stay the same as Supabase's; JSON keys and error codes for sign-in/lockout keep today's `login_lockout:*` strings (spec §7.5); the app's flows of spec §8 must keep working step for step.

### API-100-50 — Auth schema

**User story.** As the platform, I want Atlas-owned user, identity, credential and session tables, so that Atlas no longer depends on Supabase Auth.

**Acceptance criteria**
1. API migrations create `users`, `user_credentials`, `user_identities`, `device_sessions` (with `device_id` → `user_devices`), `refresh_tokens`, `auth_tokens` per spec §11.7, additive only.
2. `users.id` values equal `auth.users.id`; FKs from `profiles.id` and `safety_circle_members.user_id` are **not** repointed in this story (Phase 7).
3. Phone stored normalized `+E.164`; email as citext lower-case; both unique when not null.

**Definition of done.** Standard.
**Dependencies.** 03, 44.
**Parity references.** `auth.users` fields used (spec §4.1).

### API-100-51 — Token service, key rotation and dual-token guard

**User story.** As a user, I want short-lived access tokens with rotating signing keys, so that a stolen token is useful only briefly.

**Acceptance criteria**
1. Access JWT: asymmetric (e.g. EdDSA/ES256), lifetime 15 min, claims `sub`, `sid`, `iat`, `exp`, header `kid`; public keys at `GET /v1/auth/.well-known/jwks.json`.
2. Key rotation: new key published before use; old key kept until all its tokens expire.
3. The guard (API-100-08) accepts own tokens and, while `SUPABASE_JWT_ACCEPT=true`, Supabase tokens; revoked sessions (`device_sessions.revoked_at`) are rejected on own tokens.
4. Private keys only from secret config.

**Definition of done.** Standard.
**Dependencies.** 50, 08.
**Parity references.** Supabase JWT 3600 s (spec §8) → 15 min (decided).

### API-100-52 — Sign-up and email verification

**User story.** As a new user, I want to create an account with email, password and phone and confirm my email, so that I can sign in.

**Acceptance criteria**
1. `POST /v1/auth/signup` per spec §11.3 A1: password policy ≥ 8 with lowercase, uppercase and digit (server rule today; ASK whether to relax lowercase to match the client), duplicates → 409 `auth:email_exists` / `auth:phone_exists` (ASK: today Supabase hides duplicate emails; confirm enumeration trade-off), hash argon2id.
2. Email verification link `io.supabase.atlasmobile://login-callback/?type=signup&token=…` (scheme kept), single-use, 300 s expiry; `POST /v1/auth/email/verify` → Session.
3. `POST /v1/auth/email/resend` always 202; email channel through API-100-46 (fake until enabled).
4. Phone stored unverified; verification via API-100-53.
5. Audit `auth.signup`, `auth.email_verified`.

**Definition of done.** Standard.
**Dependencies.** 50, 51, 46.
**Parity references.** spec §8.1, §8.2; contracts SCRUM-14/15 behaviour as summarized in the spec.

### API-100-53 — Phone OTP with server-enforced limits

**User story.** As a user, I want phone verification by SMS code with fair limits enforced on the server, so that codes cannot be brute-forced.

**Acceptance criteria**
1. `POST /v1/auth/otp/send`, `/resend`, `/verify` per spec A4–A6, using Twilio Verify through the SMS adapter interface (fake until the Twilio hold is lifted).
2. Redis counters: max **3 resends per identifier per sliding 15 minutes** (429 `auth:otp_resend_limit`); **5 failed attempts invalidate the current code** until a resend (423 `auth:otp_invalidated`); a resend resets the failure count; responses include `attempts_remaining` / `resends_remaining`.
3. Code length 6, expiry 600 s (spec §6.9).
4. OTP codes are never logged or stored by the API.

**Definition of done.** Standard.
**Dependencies.** 52, 46, 11.
**Parity references.** spec §6.9 (client-only today → server-enforced), §8.3.

### API-100-54 — Password sign-in with lockout

**User story.** As a user, I want to sign in with email or phone and password, with my account protected by a lockout, so that guessing is stopped.

**Acceptance criteria**
1. `POST /v1/auth/login` `{email? | phone?, password, device}`; exactly one identifier (422 `login_lockout:identifier_exclusive` / `:identifier_required`; `:invalid_email`, `:invalid_phone`).
2. Lockout rules exactly as spec §6.8 rules 42–47: key resolution (email lower-trim; phone → that user's usable email if any, else E.164; tie-break usable email then oldest `created_at`), 5 failures within 15 min of `last_failed_at` → locked 15 min, no extension while locked, only wrong passwords count, uniform responses for known/unknown identifiers.
3. Locked → 423 `login_lockout:locked` with LockoutStatus in `details`; unconfirmed email/phone → 403 `auth:email_not_confirmed` / `auth:phone_not_confirmed`; wrong password → 401 `auth:invalid_credentials`.
4. `GET /v1/auth/lockout-status` (public) returns LockoutStatus; per-IP throttles 60 / 15 / 30 per 5 min as spec rule 48 (`login_lockout:rate_limited`).
5. Success clears the lockout keys. Verification goes through a `PasswordHasher` interface (argon2id now; API-100-58 adds the bcrypt-verify-then-rehash path for migrated users).
6. Response Session (spec §11.3); audit `auth.login.success` / `auth.login.failure`.

**Definition of done.** Standard.
**Dependencies.** 51, 11.
**Parity references.** RPCs `login_lockout_status`, `record_login_failure`, `clear_login_failures`, hook `hook_reject_locked_password_session` (spec §7.5, §7.6).

### API-100-55 — Google and Apple sign-in

**User story.** As a user, I want to sign in with Google (and Apple once enabled), so that I do not need a password.

**Acceptance criteria**
1. `POST /v1/auth/oauth/google` `{id_token, access_token?, device}`: verify signature (Google JWKS), `aud` ∈ configured client ids (Web/Android/iOS), `iss`, `exp`; link by `(provider, sub)`; existing user with the same verified email → link (ASK: confirm auto-linking policy); returns Session + `is_new_user`; clears lockout (Google, parity).
2. `POST /v1/auth/oauth/apple` `{id_token, nonce?, full_name?, device}`: verify against Apple JWKS; provider can be disabled by config (today disabled → 503 `auth:provider_disabled`, mapped by the app to "not available yet").
3. Errors: 401 `auth:oauth_invalid_token`, 409 `auth:identity_conflict`.
4. Responds well within the app's 30 s social sign-in cap.

**Definition of done.** Standard.
**Dependencies.** 51.
**Parity references.** spec §8.5.

### API-100-56 — Refresh rotation, device sessions and logout

**User story.** As a user on several phones, I want each device to have its own session that I can end, so that losing one phone does not expose the others.

**Acceptance criteria**
1. `POST /v1/auth/refresh`: refresh tokens opaque, stored hashed (SHA-256), 30-day lifetime, rotated on every use; reuse of a used token → revoke the whole family/session (401 `auth:refresh_token_reused`).
2. `POST /v1/auth/logout` revokes the current session and clears its device push token; `POST /v1/auth/logout-all` revokes all sessions (today's app default).
3. `GET /v1/me/sessions`, `DELETE /v1/me/sessions/{id}` (own only).
4. `GET /v1/me` returns User (spec A17).
5. Session lifetime cap (absolute 7 days / inactivity 7 days as the local Supabase config) — ASK before enforcing (hosted plan has none today).

**Definition of done.** Standard.
**Dependencies.** 51, 44.
**Parity references.** spec §8.7, §8.8, §8.10.

### API-100-57 — Password reset

**User story.** As a user who forgot my password, I want a reset link that lets me set a new one, so that I can get back in.

**Acceptance criteria**
1. `POST /v1/auth/password/forgot` `{email}` → always 202; link `io.supabase.atlasmobile://login-callback/?type=recovery&token=…`, single-use, short expiry.
2. `POST /v1/auth/password/reset` `{token, new_password, device}` → Session; same password policy; clears lockout; revokes other sessions (ASK: suggested).
3. Errors `auth:link_expired` (410), `auth:weak_password` (422).

**Definition of done.** Standard.
**Dependencies.** 52, 56.
**Parity references.** spec §8.6.

### API-100-58 — User migration from Supabase Auth

**User story.** As an existing user, I want to keep my account and password when Atlas moves off Supabase Auth, so that I do not have to register again.

**Acceptance criteria**
1. A repeatable, idempotent migration job copies `auth.users` → `users` (same ids, email lower-case, phone normalized `+E.164`, confirmation timestamps, `created_at`, metadata), `auth.identities` → `user_identities`, bcrypt `encrypted_password` → `user_credentials (hash_algo='bcrypt')`.
2. Sign-in (API-100-54) with a bcrypt credential verifies bcrypt and re-hashes to argon2id in the same request (`hash_algo` → `argon2id`).
3. Dry-run mode reports counts and conflicts (duplicate phones, missing emails) without writing.
4. Run only against staging until Dawit approves production; never logs hashes or personal data.

**Definition of done.** Standard. Dry run on a staging copy reviewed by Dawit.
**Dependencies.** 50.
**Parity references.** spec §12.1 (auth rows).

### API-100-59 — Phase 6 gate and dual-token cutover

**User story.** As the product owner, I want a safe switch from Supabase sessions to Atlas sessions, so that nobody is logged out unexpectedly.

**Acceptance criteria**
1. `POST /v1/auth/exchange` (suggested): a valid Supabase access token + device → an own Session once, so signed-in users move without re-login (ASK).
2. Dual-token window: both token kinds accepted; metrics show the share of Supabase tokens; acceptance switched off by config when it reaches zero or a date Dawit sets.
3. All flows of spec §8.1–§8.8 pass against the API (checklist).
4. Hand-off note for `AtlasAuth` / `SessionStore`.

**Definition of done.** Standard. Dawit approves the phase. Hand-off note `docs/phase6_handoff.md` (§5 item 8).
**Dependencies.** 50–58.
**Parity references.** spec §8, §12.2 (lockout item).

---

## 16. Phase 7 — Cutover and decommission

### API-100-60 — Per-area cutover runbook

**User story.** As the team, I want a written runbook per app area, so that each switch and each rollback is predictable.

**Acceptance criteria**
1. For each area in §7: preconditions (gate passed), app build with the API path, rollout steps, monitoring to watch, rollback steps (switch back to the Supabase path), and the date switched.
2. Kept in the API repo `docs/cutover.md`.

**Definition of done.** Standard.
**Dependencies.** 23 (first area); updated after 33, 38, 43, 49, 59.
**Parity references.** spec §12.
**Note (D13, 2026-11-19).** There is no per-area switch: this runbook covers the **single** switch of the whole app at the end (preconditions = every gate passed and approved; the mobile switch epic's build; rollout; monitoring; what to do if it fails). No per-area rollback to the Supabase path.

**Stage 7.8 (2026-11-22):** written as `docs/runbook.md` (not `docs/cutover.md`): the single switch as performed (7.1 pre-step, 7.2 staging, 7.3a-7.3d-2 app switch, 7.4/7.5 gaps, 7.6 retirement, 7.7a SendGrid), the operational runbook (API and worker processes, realtime and Redis requirements, migrations with `--allow-remote` only on an approved step, the 0012 rollback, `AUTH_JWT_KEYS` rotation, checks after a deploy) and the going-live checklist of open items. AC1's per-area entries (per-area preconditions, builds, rollback to the Supabase path and dates) are **superseded by D13**; AC2's file name changed to `docs/runbook.md`. Waiting for Dawit's approval of Phase 7.

### API-100-61 — Final parity sign-off

**User story.** As the product owner, I want one checklist proving full parity, so that Supabase app paths can be retired.

**Acceptance criteria**
1. Spec §12.2 checklist fully ticked with links to tests.
2. All 7 SQL test files fully reproduced (assertion-level checklist).
3. No app code path calls Supabase RPCs, PostgREST tables, Supabase Realtime or Supabase Auth.

**Definition of done.** Standard. Dawit signs off. Hand-off note `docs/phase7_handoff.md` (§5 item 8) for the single mobile switch epic (D13).
**Dependencies.** 23, 33, 38, 43, 49, 59.
**Parity references.** spec §12.2, §14.3.

**Stage 7.8 (2026-11-22):** `docs/parity_signoff.md`: `test:parity` 267 passed / 0 todo; `parity:report` phases 1-3 exit 0 (244 of 244 SQL assertions with a plain passing test); §12.2 mapped to the tests (AC1); the 7 SQL files reproduced (AC2); the read-only search of `mobile/` for `supabase` found only the deep-link scheme `io.supabase.atlasmobile`, the env key name `SUPABASE_AUTH_REDIRECT_URL` and comments: no app code calls Supabase (AC3). Deliberate divergences (D41, D42) and D1-D43 listed. The sign-off line waits for Dawit.

### API-100-62 — Retire Supabase app paths (keep Postgres and Storage)

**User story.** As the platform owner, I want the old Supabase app paths closed, so that there is one way into the data.

**Acceptance criteria** (each needs Dawit's approval; schema changes here are the only non-additive ones in the epic)
1. Revoke `authenticated`/`anon` EXECUTE on the app RPCs and table grants on `public` app tables (closes the owner bypass of spec §4.4); keep the functions for one release, then drop in a later migration.
2. Remove `incidents`/`incident_events` from the `supabase_realtime` publication.
3. Disable the custom access token hook and Supabase Auth sign-ups; repoint FKs (`profiles.id`, `safety_circle_members.user_id`, `user_devices.user_id`) from `auth.users` to `users`.
4. Keep Supabase Postgres and Storage `avatars`; the API holds the only service keys.
5. Production database plan decided (Supabase Pro or another host) before this story runs.

**Definition of done.** Standard. Rollback script prepared and reviewed.
**Dependencies.** 61.
**Parity references.** spec §4 (grants, RLS), §7.6, §9.

**Stage 7.6 (2026-11-22, D42):** AC1, AC2 and AC4 built by migration `0012_retire_supabase_app_paths.sql` with the rollback `db/rollback/0012_down.sql` (tested); the functions stay one release. AC3's FK repoint was done in 7.1a (D37); the hook and sign-ups are switched off in the Supabase project config (coordinator, staging step). AC5 still open. Staging apply: `docs/phase7_handoff.md` §7.6.

---

## 17. Out of scope for Epic 100 (future epics) — foundation provided by

| Jira story | Epic | What it needs (spec §15) | Foundation in Epic 100 |
| --- | --- | --- | --- |
| SCRUM-21 Add/Edit medical information | Epic 1 | multi-entry allergies/conditions, timestamps | API-100-35 |
| SCRUM-30 Remove members (status Removed) | Epic 3 | stored `removed`, revocation | API-100-32, 40, 14 |
| SCRUM-31 Leave circle (status Left) | Epic 3 | stored `left`, revocation | API-100-32, 40 |
| SCRUM-32 Landing (built; Jira not closed) | Epic 3 | incoming badge count | API-100-31 |
| SCRUM-33 Pending Invitations (Incoming/Outgoing) | Epic 3 | outgoing list, invite statuses | API-100-28, 31 |
| SCRUM-35 Test alert | Epic 3 | `test_alerts`, push | API-100-45 – 48, 11 |
| SCRUM-39 Live notes (superseded by 44) | Epic 4 | notes UI; updates table | API-100-18, 22 |
| SCRUM-44 Status updates | Epic 6 | `incident_updates`, push | API-100-22, 41, 45 |
| SCRUM-47 Emergency push | Epic 5 | FCM/APNs enabled | API-100-44 – 48 |
| SCRUM-49 Swipe to acknowledge | Epic 5 | ack UI, responder list | API-100-20, 41 |
| SCRUM-50 I'm Responding | Epic 5 | `incident_responses` | API-100-10, 22, 41 |
| SCRUM-51 Unable to respond | Epic 5 | `incident_responses` | API-100-10, 22, 41 |
| SCRUM-52 Call resident | Epic 5 | resident phone share flag | API-100-21 |
| SCRUM-53 Navigate to resident | Epic 5 | client-only | API-100-21 (location in details) |
| SCRUM-54 Emergency services shortcut | Epic 5 | numbers per region in config | API-100-17 (config pattern) |
| SCRUM-55 View other responders | Epic 5 | responders endpoint | API-100-09, 21 |
| SCRUM-56 Responder list | Epic 6 | live statuses | API-100-41 |
| SCRUM-57 Who acknowledged | Epic 6 | ack per member, live | API-100-20, 41 |
| SCRUM-58 Who is responding | Epic 6 | responding highlight | API-100-41 |
| SCRUM-59 Resident status broadcast | Epic 6 | push + realtime of updates/closure | API-100-41, 48 |
| SCRUM-60 Activity feed | Epic 6 | per-incident event feed | API-100-22 |
| SCRUM-61 Live timeline | Epic 6 | ordered events kept after close | API-100-22 |
| SCRUM-62 Last-known location label | Epic 6 | `location_source`, `location_captured_at` | API-100-17 |
| SCRUM-63 Resolution status | Epic 6 | possible `closed` state | API-100-19 |
| SCRUM-64 Incident history | Epic 6 | read-only history | API-100-21, 22 |
| SCRUM-65 Delivery confirmation | Epic 7 | per-member delivery status | API-100-47 |
| SCRUM-66 Retry failed alerts | Epic 7 | 3 retries / 60 s | API-100-47 |
| SCRUM-67 Delivery tracking | Epic 7 | logged outcomes | API-100-47, 14 |
| SCRUM-68 Last-known fallback | Epic 7 | keep last real fix | API-100-17 |
| SCRUM-69 Weak connectivity | Epic 7 | queued, idempotent actions | API-100-10, 15 |
| SCRUM-70 Offline/error messaging | Epic 7 | plain error codes | API-100-05 |
| SCRUM-71 Failed alert notification | Epic 7 | exhaustion job + event | API-100-47, 22, 41 |
| SCRUM-73 Accidental activation safeguards | Epic 7 | needs PO decision (conflicts with cancelled SCRUM-42) | none |
| SCRUM-74 Audit trail | Epic 7 | immutable log + retention | API-100-14, 22 |
| SCRUM-75 SMS fallback | Phase 1.1 | Twilio + secure link | API-100-46, 47 |
| SCRUM-76 Escalation rules | Phase 1.1 | delayed jobs + config | API-100-45, 22 |
| SCRUM-77 Multi-device | Phase 1.1 | per-device fan-out, sessions | API-100-44, 56, 10 |
| SCRUM-81 Multiple circles + active-incident labels | Epic 3 | joined list without own, `active_incident_id` | API-100-31, 09, 41, 42 |
| SCRUM-82 Activity log | Epic 5 | `GET /v1/me/activity` from events | API-100-22, 09 |
| Incident messaging (Epic 6, no story text yet) | Epic 6 | messages in active incident, read-only after close | API-100-09, 40 |

## 18. Decisions (resolved 2026-11-17 by Dawit)

These answers replace the former open questions. **Where any story in this epic still lists alternatives, this table decides.**

| # | Topic | Decision | Applies to |
|---|---|---|---|
| D1 | Database baseline for the API repo | Supply the **37 migration files + the 7 SQL test files** (not a schema dump). The tests are the behavioural spec. | §6, API-100-03, API-100-13 |
| D1b | Postgres version | **PostgreSQL 17.11** (hosted project, read 2026-11-17). Local docker image must match. | §6, API-100-03 |
| D2 | `GET /v1/me/incidents/open` with no open incident | `200 { "open_incident": null }` (always the same wrapper shape). | API-100-16 |
| D3 | `recipient_ids` in incident event details | **Hidden from members**; only the resident (incident owner) sees them. | API-100-22 |
| D11 | `actor_id` of incident events for non-resident callers (decided 2026-11-19) | **Shown obscured**: keep the first 4 and the last 4 hex characters, replace every other hex character with `*`, keep the hyphens and the 36-character UUID shape (`4f3a1c2d-9e8b-4a7c-b6d5-1234567f9c2d` → `4f3a****-****-****-****-********9c2d`), lowercase. The resident always sees the full id on their own incident; an actor who is the caller is shown in full; null stays null; a malformed value is fully masked. Sits alongside D3 (unchanged). | API-100-22 |
| D4 | Notification preferences vs SOS | **SOS always notifies every eligible active member**; `alert_*_enabled` only governs non-emergency messages. (Dawit will confirm with the PO; build it this way.) | API-100-48 |
| D5a | Password policy | Keep **min 8 + uppercase + lowercase + digit** on the server; the app is updated to check lowercase too. | API-100-52 |
| D5b | Duplicate email at sign-up | **Do not reveal it**: same neutral "check your email" response whether or not the email exists. | API-100-52 |
| D6 | Google/Apple sign-in on an email that already has a password account | **Auto-link only when the provider asserts the email is verified**; otherwise refuse with a neutral error. | API-100-55 |
| D7 | Session timebox | **Enforce once own auth ships**: refresh tokens rotate (30-day lifetime) and an idle session (no refresh for **7 days**) requires sign-in again. | API-100-56 |
| D8 | Auth cutover | Provide a **one-time session exchange** (valid Supabase session → API session) so users are not logged out. | API-100-59 |
| D9 | Hosting | Production DB = the **existing Supabase project, upgraded to Pro before go-live** (Dawit subscribes). API on a container host in an EU region near the database (`eu-west-1`); exact provider chosen by the team. Staging optional/later. The project is now the new `atlas_staging` project (see D12). | §6, API-100-62 |
| D10 | Database role for the API | Use the **existing database role** (no dedicated least-privilege role for now). Keep the connection string only in server env/secrets; never in the app. | §6, API-100-02/03 |
| D12 | Supabase project for the API (decided 2026-11-19) | The **original Supabase project was a prototype**: it is **frozen** (read-only reference; nothing is written to it) and will be scrapped. The **new Supabase project `atlas_staging`** (`eu-west-1`) is the API's database and avatar Storage going forward. **No data migration** (there are no real users). D9's "existing Supabase project, upgraded to Pro" now means this new project. It runs **PostgreSQL 17.12** (the baseline and D1b were written for 17.11); the 37 baseline migrations and API migrations 0001–0003 were applied with the db tooling and **all 7 SQL tests pass on 17.12**. Its Auth settings were copied from the prototype (non-secret settings only; Google native ID-token sign-in with the same client IDs; phone/SMS provider off while Twilio is on hold). | §6, D1b, D9, API-100-03, API-100-62 |
| D13 | Cutover approach (decided 2026-11-19) | **One switch at the end.** The whole API (Phases 2–7) is built first; then the **entire mobile app moves to the API in one mobile epic** (own auth, all data, Socket.IO realtime, push); then the team tests and optimises; then the remaining Jira stories are built on the API. **No per-area switch and no Supabase fallback path in the app.** Phase gates still prove parity with the SQL; Dawit's per-phase sign-off is the gate's **manual Git Bash test guide** (no app switch per phase). Every gate (33, 38, 43, 49, 59, and 61/62 where they change what the app calls) writes `docs/phaseN_handoff.md` for the mobile agent in the structure of `docs/phase1_handoff.md` (§5 item 8). The per-area switch/rollback of `docs/phase1_handoff.md` §5 is superseded (kept as reference) and the `app_config` row `client_incidents_backend` (API migration 0004) is unused. Replaces the area-by-area (strangler) app cutover of §2, §7, API-100-60 and spec §11.1 / §12. | §2, §5, §7, gate stories 23, 33, 38, 43, 49, 59, API-100-60/61/62 |
| D14 | SOS submit racing a member who leaves or is removed (decided 2026-11-20) | **"An SOS must always go through."** The API's submit reads the circle's active member rows **`FOR KEY SHARE`** in the same statement as its `incident_deliveries` insert (the lock the foreign key check takes anyway, only taken earlier). A member who leaves or is removed concurrently is then **not notified** instead of the submit failing with 23503 (`incident_deliveries_member_id_fkey`), which the SQL `submit_emergency_alert` can still do. Everything else is unchanged (events, sorted `recipient_ids`, counts, response). Checked for the same pattern elsewhere: no other API write inserts a row referencing a member or profile that can be deleted concurrently (re-notify only updates deliveries; acknowledge locks its delivery row and answers `not_found` once it is gone; mark safe stores closure recipient ids as JSON; events reference the resident's own locked profile). The SQL function is left as it is. | API-100-15, API-100-32, API-100-33 |
| D15 | Remove with a member id of another circle (decided 2026-11-20) | `DELETE /v1/circles/{circle_id}/members/{member_id}` checks the circle in the path: a `member_id` that is not a row of `{circle_id}` → 404 **`remove_circle_member:not_found`**, also for the owner of that other circle. **Stricter than the SQL** (`remove_circle_member(member_id)` takes no circle); approved. | API-100-32 |
| D16 | Profile writes: validation and timestamps (API-100-35, Phase 3; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 3) | New `profiles:*` codes, checked in the body's field order, each naming `details.field`: `invalid_full_name`, `invalid_date_of_birth`, `invalid_gender`, `invalid_avatar_path`, `invalid_emergency_contact_full_name`, `invalid_relationship`, `invalid_phone`, `invalid_email`, `invalid_blood_type`, `emergency_notes_too_long` (422); `profile_not_found` (404, after the body checks); `not_authenticated` (401, also for a valid token whose user no longer exists). A value of the wrong JSON type (or text Postgres cannot hold) is 422 `validation:invalid_request`, as on every route. Text is trimmed like the app's Dart `trim()` (all whitespace); blank optional text → null. The contact phone must be strict E.164 `^\+[1-9][0-9]{7,14}$` (the rule of `complete_profile_setup`, stricter than the app's own `{6,14}`), so a saved number can always complete setup; no country code is added by the server. Date of birth: a real `YYYY-MM-DD` not after the database's current date in UTC (= Africa/Banjul). `avatar_path` of Personal Info must be a path in the caller's own folder (no Storage check, no deletion: as today). In Personal Info a left-out `gender` / `avatar_path` keeps the stored value and null clears it (the app always sends both). The server owns `personal_info_completed_at`, `emergency_info_completed_at`, `preferences_completed_at` (set to `now()` the first time, never reset) and `profile_setup_completed_at` (P7 only); a request cannot write any of them. The sharing-flags PATCH ignores other keys; an empty body changes nothing. | §4.2, §11.3 P1-P6, epic API-100-34/35 |
| D17 | Avatar storage (API-100-37, Phase 3; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 3) | Storage calls go through `AvatarStorage`: Supabase Storage (REST, server key `SUPABASE_STORAGE_SERVICE_KEY`, required when `NODE_ENV=production`, never logged) or an in-memory fake (`AVATAR_STORAGE=memory`, tests and local manual testing only; refused in production). `POST /v1/me/avatar/upload-url` needs no profile (onboarding uploads first), signs a single-use URL valid 2 hours for a NEW object `{uid}/avatar-{uuid}.{jpg|png|webp}` (no upsert, so no stale cached photo), answers `cache-control: no-store` and has its own per-user limit `avatar_upload` (20 per hour, `RATE_LIMIT_AVATAR_UPLOAD_*`). `PUT /v1/me/profile/avatar` checks the caller's folder (422 `profiles:invalid_avatar_path`), the profile (404), the object (404 `profiles:avatar_not_found`, new), sets `avatar_path`, then deletes the previous object of the caller's folder after the commit (best effort; a failure is logged without the path and the request still succeeds). Storage not configured or not answering: 503 `profiles:avatar_storage_unavailable` (new). `avatar_url` stays `{SUPABASE_URL}/storage/v1/object/public/avatars/{avatar_path}`; existing `{uid}/avatar.{ext}` paths stay valid. | §4.11, §11.3 P8/P9, epic API-100-37 |
| D18 | Profile setup lock order (API-100-36, Phase 3; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 3) | `POST /v1/me/profile/complete` locks the caller's profile, then the caller's circle (`FOR UPDATE`, or creates it: `on conflict (owner_id)` then lock, never a 23505), then the owner row (upsert, `membership.activate` path `profile_setup_owner_row`), then the emergency contact's row. Every API writer of a circle therefore takes the circle before any member row. The SQL `complete_profile_setup` locks the owner row first and the circle only in the contact row's capacity trigger, so it can deadlock (40P01) with a writer that takes the circle and then the owner row (e.g. `resend_circle_invite` of the owner row). Same answers and rows as the SQL otherwise; the SQL function is left as it is (the hazard goes with the switch). The audit row `profile.setup_completed` is written once, by the first completion (detail: ids, `deferred`, `circle_created`, the contact row's status; never a name or phone). | §6.1, §7.1, §11.3 P7, epic API-100-36 |
| D19 | Realtime transport and session (API-100-39, Phase 4; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 4) | Socket.IO 4 on the API's own HTTP server, engine path `/socket.io`, namespace `/v1/realtime` only (the default namespace refuses with `connect_error` `realtime:not_found`), **websocket transport only** (no long-polling, so no sticky sessions behind a load balancer), no connection-state recovery (nothing replayed), client packets at most 16 KiB. Handshake `auth: {token}` through the REST verifier: missing, malformed, invalid, expired, or already past `exp` inside the verifier's clock skew → `connect_error` with `message` and `data.code` `auth:session_expired`; a token that cannot be checked at all (key server down) → `internal:error` (never a sign-out). At the token's `exp` the server sends `session.expired` `{code: "auth:session_expired"}` and disconnects (reason `io server disconnect`; the client reconnects with a fresh token). Redis adapter channels prefixed `REALTIME_ADAPTER_KEY` (default `atlas:realtime`; tests use one per worker), its own publisher (no offline queue: a failed cross-instance publish is logged once per outage, local sockets still get the event) and subscriber; `/readyz` gains the check `realtime` (both adapter connections), listed after `migrations` in `failed`. The contract is published as data under `x-realtime` in `openapi.json`. | spec §11.5, epic API-100-39 |
| D20 | Incident rooms (API-100-40, Phase 4; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 4) | `incident.join {incident_id}` acks `{ok: true}`, or `{ok: false, error: {code}}` with `get_incident_details:not_found` (denied or unknown, as REST), `validation:invalid_request` (no uuid `incident_id`), `rate_limit:exceeded` (more than 60 joins per socket per minute, counted per instance) or `internal:error` (the check failed). The check is one SQL statement of `incident.resident` OR `incident.memberView` per join (no cached grant). A joined socket is in `incident:{id}`, `incident:{id}:user:{uid}` and, for the resident, `incident:{id}:resident`. Membership end: only remove and leave end an active membership in Phases 1-3 (resend, cancel and decline refuse active rows); their committed end reaches every instance through the adapter (`serverSideEmit`) and takes that user's member sockets out of every incident room of that circle. A join whose check overlapped a revocation of the same user and circle on that instance is refused (`not_found`), so a removal racing a join never leaves the socket in the room. A membership ended by the old app through the SQL functions does not evict live sockets (they only exist once the app uses the API, D13); the next join is refused. | spec §11.5, epic API-100-40 |
| D21 | Broadcast payloads and recipients (API-100-41/42, Phase 4; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 4) | Every broadcast reads the committed state after the commit (one read-only statement in UTC; ids only travel through the hook). `occurred_at` = database time of that read (`statement_timestamp()`; a later read never shows older state, so clients drop an event whose `occurred_at` is older than the last applied one of the same kind); for `incident.event` it is the event row's `occurred_at`. `updated_at` = `incidents.updated_at` (the trigger's `now()`, the write's transaction start: two overlapping writes can commit in the opposite order, so it is informative, not the ordering key). Row events (`updated`, `location`, `notes`, `renotified`, `resolved`, `delivery_counts`, `incoming`) carry both. `incident.updated.incident` has the 16 keys of spec §11.5, `share_payload` `{}` when null (as REST details). `incident.delivery_counts` goes to `user:{resident_id}` (every socket of the resident, no join needed) on submit, re-notify, the first acknowledge and the close (the close is added so another device of the resident sees the status). `incident.event` is sent per receiver: the resident room gets the row as stored, the acting member's own sockets their id unmasked, everyone else D3 + D11. `incident.incoming` (created/promoted submit) and `incident.renotified` (explicit re-notify and a submit on an active incident) go to `user:{id}` of each delivery row's user who passes `incident.memberView` at send time (D14 rows; a member removed since is skipped); `renotified` goes to the incident room in the same broadcast, so a socket in both gets it once. `incident.incoming` carries `updated_at` / `occurred_at` besides the keys of spec §11.5. | spec §11.5, epic API-100-41/42 |
| D22 | Device registration (API-100-44, Phase 5; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 5) | `PUT /v1/me/devices/current` (U1) and `DELETE /v1/me/devices/current/push-token` (U2) name the installation with `X-Atlas-Installation-Id`: a UUID in the 8-4-4-4-12 form (any case, stored lowercase); missing or anything else → 422 **`user_devices:invalid_installation_id`** (`details.field` `x-atlas-installation-id`), checked before the body. U1 body, in field order: not a JSON object → 422 `validation:invalid_request`; `platform` (`android`\|`ios`) → `user_devices:invalid_platform`; `app_version` (required, trimmed, 1-64 printable characters) → `user_devices:invalid_app_version`; `push_provider` (`fcm`\|`apns`) → `user_devices:invalid_push_provider`; `push_token` (1-4096 visible ASCII characters) → `user_devices:invalid_push_token`; a token needs its provider (else `invalid_push_provider`) and a provider its token (else `invalid_push_token`). Both left out = keep the stored token; `null` = clear it. The upsert on (user, installation) sets `platform`, `app_version`, `last_seen_at = now()` and clears `revoked_at`; `push_token_updated_at` changes only when the token or provider changes. A token is on one row of any user: registering it clears it from every other row first (one transaction, serialized per token by an advisory lock). A valid token whose user no longer exists → 401 `user_devices:not_authenticated`. U2 answers 204 also when there is nothing to clear and touches only the caller's row of that installation. Not audited. A push token never reaches a log line, an error body or `audit_log` (database errors are replaced by a code-only error; the scrubber redacts `*token*` keys). Default authenticated rate limit; no Idempotency-Key. | spec §11.3 U1/U2, §11.7, epic API-100-44 |
| D23 | Outbox, relay and worker process (API-100-45, Phase 5; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 5) | `notification_outbox` has one column more than spec §11.7: `deliver_at` (null = at once; else a delayed job, foundation for SCRUM-76). Domain writes insert the row in their own transaction. The relay runs in every process (API and worker) on its own single database connection: a sweep every `OUTBOX_RELAY_INTERVAL_MS` (1 s) and right after each committed incident write (post-commit kick); batches of `OUTBOX_RELAY_BATCH_SIZE` (100) claimed `FOR UPDATE SKIP LOCKED`; the job is added before `published_at` is written (at-least-once), job id = outbox id (a re-publish is ignored while the job is kept: completed 24 h, failed 7 days) and consumers are idempotent by outbox id. BullMQ 6.7.8 on `REDIS_URL`, keys under `JOBS_QUEUE_PREFIX` (`atlas:jobs`), queues `notification-outbox` (5 attempts, 1/2/4/8 s) and `notification-deliveries`. Workers run from the same build and image with **`WORKER=1`** (no HTTP server, no `/readyz`), `JOBS_WORKER_CONCURRENCY` (10) jobs per queue. `/readyz` gains the check **`jobs`** (the producers' Redis connection), listed after `realtime` in `failed`. Every failed attempt is logged (`job failed, will retry` / `job failed, no retries left` with queue, job id, attempt and an error code only); errors stored by BullMQ carry a code, never SQL parameters, tokens or addresses. | spec §11.6, §11.7, epic API-100-45 |
| D24 | Channel adapters (API-100-46, Phase 5; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 5) | Adapters are chosen at startup: push `CHANNEL_PUSH_ADAPTER=fake\|real` (real = FCM HTTP v1 with service-account OAuth for `fcm` tokens and APNs HTTP/2 token auth for `apns` tokens; keys all-or-none per provider, at least one provider; a token of a provider without keys fails `not_configured`); SMS `CHANNEL_SMS_ADAPTER=fake\|twilio`, where **`twilio` is refused at startup unless `CHANNEL_SMS_TWILIO_HOLD_LIFTED=true`** and all Twilio keys are set (the Twilio hold); email: the fake only (no provider chosen). Every adapter defaults to `fake`. `CHANNEL_*_ENABLED` (all default false) decides whether a channel sends at all: disabled → the delivery is `skipped`, no adapter is called. Production refuses an enabled channel on a fake adapter, and `CHANNEL_EMAIL_ENABLED=true`. Each send answers `{provider_message_id, status: sent\|delivered\|failed, error_code?}`; permanent codes `unregistered`, `invalid_recipient`, `invalid_request`, `not_configured`; retried codes `auth_failed`, `rate_limited`, `provider_unavailable`, `timeout`, `transport_error`, `fake_unavailable`. Push content: data keys `topic`, `incident_id`, `emergency_type`, `resident_name`, `occurred_at` and an English title (the resident's name) and body (the type); nothing else (no share, medical, note, location or member data). The real adapters are unit-tested against a fake HTTP transport only. The fake push adapter fails tokens starting `fake-fail-` (transient) and `fake-unregistered-` (`unregistered`), for tests and the manual guide. | spec §11.6, epic API-100-46 |
| D25 | Delivery records and retries (API-100-47, Phase 5; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 5) | `notification_deliveries` has one column more than spec §11.7: `preferences` (the recipient's `alert_push_enabled` / `alert_sms_enabled` / `alert_email_enabled` at fan-out; recorded, not enforced for SOS, D4). Unique per (outbox row, recipient, channel, device or none): the fan-out is idempotent. `device_id` cascades with its device (deleted only with its user); no foreign key on `recipient_user_id` / `incident_id`. Fan-out: push = one row per device with a token (not revoked), none → `skipped` `no_device`; SMS / email = one row per recipient, no phone / email → `skipped` `no_address`; a disabled channel → `skipped` `channel_disabled`; a recipient who fails the eligibility check → one `skipped` `not_eligible` row per channel. A row stays `queued` between retries (with the last `error_code`), then `sent` / `delivered` (with the provider id and `sent_at`) or `failed`. Retries: `NOTIFICATIONS_RETRY_ATTEMPTS` (3) with exponential backoff from `NOTIFICATIONS_RETRY_BASE_DELAY_MS` (2 s: retries after 2, 4 and 8 s); a configuration whose retries would not fit in 60 s is refused. Permanent errors fail at once; `unregistered` also clears the push token from `user_devices` (only while the device still holds that token). The worker's status writes use `synchronous_commit = off` (bookkeeping: a crash can repeat one push, never lose one). No read endpoint (SCRUM-65). | spec §11.6, §11.7, epic API-100-47 |
| D26 | Incident notices (API-100-48, Phase 5; proposed by the API agent 2026-11-20 for Dawit's approval with Phase 5) | API submit (created or promoted → `incident.created`; on an active alert → `incident.renotified`), explicit re-notify (`incident.renotified`) and the mark safe that closes the alert (`incident.resolved`; never the already-safe no-op) insert their outbox row in their own transaction. Payload `{incident_id, emergency_type, resident_name, occurred_at, recipient_user_ids}` (`occurred_at` = `sent_at` / `renotified_at` / `resolved_at`); recipients = the incident's delivery rows (D14) for created / renotified and `closure_notified.recipient_ids` (rule 54) for resolved; a row is written also when there is no recipient. At fan-out every recipient is checked again with `incident.memberView` (as the realtime recipients, D21); one who fails is `skipped` `not_eligible`. **Channel: push only** in Epic 100 (SMS is the SCRUM-75 fallback, under the Twilio hold; email is not an incident channel in any story). D4 applies to all three notices: preferences recorded, never enforced. The SQL functions (today's app) write no outbox row: only API writes notify (the whole app moves to the API at once, D13). The request never waits for a notification (one INSERT in the transaction, a non-blocking relay kick after the commit). | spec §11.6, epic API-100-48 |
| D27 | Own access tokens, keys and the dual-token guard (API-100-51, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | Access JWT EdDSA (Ed25519) or ES256 by the key, 15 min (`AUTH_ACCESS_TOKEN_TTL_SECONDS`), header `kid` + `typ: at+jwt`, claims `iss` (`AUTH_JWT_ISSUER`, default `atlas-api`), `aud` (`AUTH_JWT_AUDIENCE`, `atlas-app`), `sub`, `sid`, `iat`, `exp` only. Keys only from secret config: `AUTH_JWT_KEYS` (JSON array of JWKs with `kid`; with `d` = can sign, without = verify only) + `AUTH_JWT_ACTIVE_KID`; both required in production; validated at startup (messages name the key, never material); `npm run -s auth:keygen`. Every key's public part is at `GET /v1/auth/.well-known/jwks.json` (public, not rate limited, `cache-control: public, max-age=300`, active first). Rotation: add the new key (published before use), make it active, remove the old one after 15 min + skew. The guard picks the verifier by `iss`; an own token needs a live `device_sessions` row of its `sub` and a user not disabled (one primary-key read per request; a revoked session is refused at once, REST and realtime). Supabase tokens are accepted while `SUPABASE_JWT_ACCEPT=true` (default) and before `SUPABASE_JWT_ACCEPT_UNTIL`. The share of Supabase tokens: per-UTC-day Redis counters (requests, distinct users, 40 days, written every 10 s off the request path), `npm run -s auth:token-usage`, and a `token usage` log line every 15 min per instance. | spec §11.1, §11.2, epic API-100-51/59 |
| D28 | Sign-up, email links and the test mailbox (API-100-52, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | `POST /v1/auth/signup` answers **202 `{verification: {channel: "email", expires_in_seconds: 300}}`** for a new AND an existing email (D5b; no user object, so nothing tells them apart; the password is hashed either way). The same for the phone (no `auth:phone_exists`): a phone held by another user is kept in `metadata.signup_phone` only. An existing unconfirmed email gets a new link, a confirmed one nothing. Fields checked in order email, password (D5a, 8-128), phone (strict `+E.164`), full_name (1-100), device. Links `io.supabase.atlasmobile://login-callback/?type=signup|magiclink|recovery&token=...` (32 random bytes, SHA-256 at rest, single use, `AUTH_EMAIL_LINK_TTL_SECONDS` 300 s; a newer link of a purpose replaces older ones → 400 `auth:link_invalid`; past expiry 410 `auth:link_expired`). `email/resend` supports `signup` and `magic_link` (a sign-in link, also confirms the email). 4 emails per address per sliding 15 min (sign-up, resend and forgot together; 429 `auth:over_email_send_rate_limit`, also for unknown addresses). Per IP (Supabase's limits of today, spec §8): sign-up / sign-in 30, verifications 30, sends 30, refresh 150 per 5 min. Emails go through the Phase 5 email adapter after the commit (fake only, D24; a disabled channel sends nothing). Test-only `GET /__test/auth-messages?to=` serves what the FAKE adapters sent (links, codes), only with `AUTH_TEST_MAILBOX_ENABLED=true`, refused in production. New codes: `auth:invalid_full_name`, `auth:invalid_device`, `auth:user_disabled`. | spec §8.1, §8.2, §11.3 A1-A3, epic API-100-52 |
| D29 | Phone OTP (API-100-53, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | Codes through a `PhoneVerifier`: Twilio Verify (needs the Twilio adapter, the hold lifted and `TWILIO_VERIFY_SERVICE_SID`; without that SID no codes at all) or the fake (6 digits, 600 s, in memory, texted through the SMS adapter). SMS channel off → 503 `auth:sms_unavailable`. Limits per number in Redis (keys hold a SHA-256 of the number), **fail closed** (Redis down → 503): 4 codes (send + 3 resends) per sliding 15 min (429 `auth:otp_resend_limit`, `details.resends_remaining`), a code usable 600 s after it was sent (410 `auth:otp_expired`), attempts counted atomically before the check: attempts 1-4 wrong → 400 `auth:otp_invalid` with `attempts_remaining`, the 5th and later → 423 `auth:otp_invalidated` until a resend (which resets the count). `sign_in` sends only to a number of an account and never creates one; an unknown number gets the same answers and counts. `verify_phone` needs the account's access token and its own number (else 422 `auth:invalid_phone`) and answers `{user}`; A6's documented response is one object (`OtpVerified`, the Session keys optional). Codes are never logged or stored by the API. | spec §6.9, §8.3, §11.3 A4-A6, epic API-100-53 |
| D30 | Password sign-in and the lockout (API-100-54, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | The counters stay in **`public.login_lockouts`** (the table of the SQL functions), so the old app, the API and the Supabase access-token hook share one counter per account during the window; rules 42-47 statement for statement as `login_lockout_status` / `record_login_failure` / `clear_login_failures` (proved against them on the same state), the key resolved against `users`, the row created `on conflict do nothing` before it is locked (parallel first failures all count). Order: lock check (423 with LockoutStatus, before any password), password (an unknown account or one without a password spends the same argon2 time), wrong → counted, 401 `auth:invalid_credentials` with the LockoutStatus in `details`, the 5th → 423; right → the lock is checked again (hook parity), then the identifier used must be confirmed (email sign-in `email_confirmed_at`, phone sign-in `phone_confirmed_at`, as GoTrue: 403, not counted), a disabled user 403 `auth:user_disabled`, the user's email and E.164 rows cleared, bcrypt re-hashed, a session. Rule 48 per IP in Redis sliding 5-minute windows (the API's limiter) instead of the SQL's fixed window table: login and lockout-status share 60; wrong passwords 15 (over → 429, not counted, as the SQL); clears 30 (over → the sign-in succeeds without clearing, as the app's non-blocking clear). | spec §6.8, §7.5, §7.6, §11.3 A7/A8, epic API-100-54 |
| D31 | Google and Apple (API-100-55, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | Google is on when `GOOGLE_CLIENT_IDS` lists the client ids (`aud`); `iss` `https://accounts.google.com` or `accounts.google.com`; Apple only with `APPLE_SIGN_IN_ENABLED=true` + `APPLE_CLIENT_IDS` (`iss` `https://appleid.apple.com`). JWKS URLs are config (`GOOGLE_JWKS_URL`, `APPLE_JWKS_URL`; tests use a local fake), 5 s fetch timeout; keys unreachable → 503 **`auth:provider_unavailable`** (new). Off → 503 `auth:provider_disabled`. Account: by `(provider, sub)`; else an account with that email is linked only when the token says `email_verified` true (D6; the email then counts as confirmed), otherwise 409 `auth:identity_conflict` with neutral wording; else a new account (email confirmed when verified; `is_new_user: true`). `access_token` is accepted and ignored. Apple: a nonce on either side must match (token `nonce` = SHA-256 hex of the raw nonce); `full_name` kept in metadata for a new account. Google clears the lockout rows (rule 47); Apple does not (as today). | spec §8.5, §11.3 A9/A10, epic API-100-55 |
| D32 | Refresh, sessions and sign-out (API-100-56, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | Refresh tokens: 32 random bytes, SHA-256 at rest, `AUTH_REFRESH_TOKEN_TTL_DAYS` 30, one family per session; every refresh marks the token used and issues a child. **Strict reuse detection** (no 10 s grace as Supabase): a used token presented again revokes the session and all its tokens (401 `auth:refresh_token_reused`, audit `auth.refresh.reuse_detected`); unknown / revoked / disabled → 401 `auth:session_expired`. D7: a session whose last refresh is older than `AUTH_SESSION_IDLE_DAYS` (7) is revoked (`idle`) at its next refresh; `refresh_token_expires_at` answers the use-by time = min(30-day expiry, 7-day idle). Sessions store platform, device name, app version, installation id, IP, user agent; linked to `user_devices` by `X-Atlas-Installation-Id` at sign-in or by U1 with an own token. Logout revokes the caller's session and clears its device's push token; with a Supabase token it is a 204 no-op. Logout-all revokes every session and clears the push token of every device of the user. Sessions list: live and not idle, most recently used first, `current`; delete: own live session only, anything else 404 `auth:session_not_found` (new). `GET /v1/me` moves a Supabase-only user first (D34). | spec §8.7, §8.8, §11.3 A11-A13, A17, A19, A20, epic API-100-56 |
| D33 | Password reset (API-100-57, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6; the session rule is Dawit's chosen default, changeable) | Forgot: always 202, a `type=recovery` link (300 s, single use) to an account of that email (not disabled). Reset checks the link first (400 / 410), then the policy (422 `auth:weak_password`, field `new_password`) and a change (422 `auth:same_password`); a refused password leaves the link usable. Then argon2id, the email counts as confirmed, the lockout rows cleared (rule 47), **every other session of the user revoked** (`password_reset`), audit `auth.password.reset {sessions_revoked}`, a new session (`auth_method` recovery). | spec §8.6, §11.3 A14/A15, epic API-100-57 |
| D34 | User migration from Supabase Auth (API-100-58, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | `npm run auth:migrate-users [-- --dry-run] [--allow-remote]`: one transaction (dry run = the same statements rolled back, counts only, no personal data), db tooling target guard (local only unless `--allow-remote`; run so far only on the local docker database). Anonymous and deleted users skipped; email `lower(btrim())` when usable, phone `_normalize_e164` when strict E.164; an email or phone that another user holds, or that an older / emailless twin shares (rule 44's tie-break: usable email first, then oldest), is left out and counted as a conflict (`missing_email`, `invalid_email`, `duplicate_email`, `invalid_phone`, `duplicate_phone`); `raw_user_meta_data` → `metadata`; bcrypt `encrypted_password` → `user_credentials` (`bcrypt`); `auth.identities` (google, apple, email, phone; when the table exists) → `user_identities`, plus an `email` / `phone` identity for every migrated email / phone. Repeatable: present rows keep what the API owns; only a confirmation Supabase has is added; a bcrypt credential follows a newer Supabase hash, an argon2id one is never replaced. Bcrypt is verified at sign-in and re-hashed to argon2id in the same request. **Just in time**: sign-up, resend, forgot, login, OTP sign-in, Google/Apple, `GET /v1/me` and the exchange first move a Supabase user that is not in `users` yet (no second account for the same email). | spec §12.1, epic API-100-58 |
| D35 | Session exchange (API-100-59, Phase 6; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | `POST /v1/auth/exchange {device}` with the **Supabase** access token as the bearer → an API Session (`auth_method` exchange) for the same user (moved first, D34), once per Supabase session: the token's `session_id` is stored in `device_sessions.exchanged_supabase_session_id` (unique, migration 0009; a second or concurrent exchange → 409 `auth:session_already_exchanged`). An own token, or a Supabase token without a uuid `session_id` → 403 `auth:exchange_not_allowed`. Works only while Supabase tokens are accepted (D27). Audit `auth.session.exchanged`. | spec §12.1, epic API-100-59 |
| D36 | Accounts created by the API before Phase 7 (Phase 6 finding; proposed by the API agent 2026-11-21 for Dawit's approval with Phase 6) | `users` is the source of accounts, but the foreign keys of `profiles.id`, `safety_circle_members.user_id` and `user_devices.user_id` still point at `auth.users` (API-100-50 AC2: not repointed before Phase 7). An account created by API sign-up or by a first Google / Apple sign-in therefore has no `auth.users` row: sign-in, sessions and `GET /v1/me` work, but device registration answers 401 `user_devices:not_authenticated` and profile / circle writes are refused by the foreign keys. Migrated accounts (every account of the old app) are not affected. **API-100-62 must repoint those foreign keys before the app switches** (D13's order already puts Phase 7 first); no shadow `auth.users` rows are written. **Stage 7.1a (2026-11-21): done by migration 0010 (D37); new API sign-ups now write their profile, circle and device rows end to end (`test/int/phase7-new-account-writes.int-spec.ts`).** | epic API-100-50, API-100-62, D13 |
| D37 | Foreign keys repointed at `users`, back-fill and the compatibility trigger (stage 7.1a, D36; proposed by the API agent 2026-11-21 for Dawit's approval with stage 7.1) | Migration **0010** repoints `profiles_id_fkey` (on delete cascade), `safety_circle_members_user_id_fkey` (on delete set null) and `user_devices_user_id_fkey` (on delete cascade) from `auth.users` to **`public.users`**, with the same names and delete rules (the API's 23503 mappings stay). First it back-fills every `auth.users` id missing from `users` with `api_ensure_user_row(id)`: D34's rules for one user (email `lower(btrim())` when usable, strict `+E.164` phone, an email or phone another user holds left out, metadata, confirmations, `created_at`, a bcrypt credential, `email` / `phone` identities; a user Supabase marked deleted gets a disabled row; `auth.users` is never written), oldest first with a usable email first (rule 44). Local docker database on 2026-11-21: 1,207 `auth.users` rows, 0 missing from `users`, 0 moved. **The old SQL functions keep working for the parity tests**: a `BEFORE INSERT / UPDATE` trigger on each of the three tables (`*_ensure_user_row`; SECURITY DEFINER, empty search_path, not executable by `anon` / `authenticated`) runs `api_ensure_user_row` for the referenced id, so a write for a user that exists only in `auth.users` (how the 7 baseline SQL files, which cannot be edited, and the parity suites create their users, as today's app did) moves that user first; an id in neither table still fails with 23503. Test support changed only where a fixture set a bcrypt password after its profile (`createUser({encryptedPassword})`) or inserted a `users` row the trigger now writes. On a database with Supabase users run `npm run auth:migrate-users` before 0010 (the batch also copies Google / Apple `auth.identities`). The trigger and the helper are removed with the Supabase app paths in a later stage. | epic §16, D34, D36, spec §11.7 |
| D38 | A16 `PUT /v1/auth/password`: change the password while signed in (stage 7.1b; proposed by the API agent 2026-11-21 for Dawit's approval with stage 7.1) | Body `{current_password, new_password}` → **204**. Checked in the reset's order (D33): `current_password` missing or not a string → 422 `validation:invalid_request` (`details.field`); wrong, or the account has no password (the same argon2 time) → **401 `auth:invalid_credentials`** with `details.field: current_password` (not counted in `login_lockouts`; not a dead session: only `*:not_authenticated` means that); the D5a policy → 422 `auth:weak_password` (field `new_password`); equal to the current password → 422 `auth:same_password`. Then argon2id and **every OTHER session of the user revoked** (D33's rule; new reason `password_change`, migration **0011** widens the check constraint; a Supabase-token caller, only possible with `SUPABASE_JWT_ACCEPT=true`, has no API session to keep, so all are revoked); audit `auth.password.changed {sessions_revoked}`; the lockout rows are not touched (no sign-in). **10 attempts per user per sliding 15 minutes** (429 `rate_limit:exceeded`). | spec §11.3 A16, D5a, D33 |
| D39 | A18 change phone (stage 7.1c; proposed by the API agent 2026-11-21 for Dawit's approval with stage 7.1) | Two routes. **`PUT /v1/me/phone {phone}`** → 202 `{verification: {channel: "phone", expires_in_seconds: 600, resends_remaining}}`: a code to the NEW number through the `PhoneVerifier` (the fake while the Twilio hold is on); calling it again is the resend. **`POST /v1/me/phone/verify {phone, code}`** → 200 `{user}`: only now the number becomes the account's phone, confirmed, with a `phone` identity; audit `auth.phone.changed {had_number, same_number}` (no number). The account keeps its old phone until then. API-100-53's limits per number (4 codes per sliding 15 minutes → 429 `auth:otp_resend_limit`; attempts 1-4 → 400 `auth:otp_invalid` with `attempts_remaining`, the 5th → 423 `auth:otp_invalidated` until a resend; 600 s → 410 `auth:otp_expired`; Redis down → 503, fail closed; SMS channel off → 503 `auth:sms_unavailable`), per IP as the OTP routes (30 per 5 minutes). The pending number is kept in Redis as a SHA-256 for 600 s (a newer request replaces it); a `phone` that is not the pending number → 422 `auth:invalid_phone`. **A number another account holds**: the same 202, counted the same, but no code is sent and no code verifies (no enumeration, as D28 / D29; the 409 `auth:phone_exists` of the spec row is not used); taken in between → 422 `auth:invalid_phone` at verify. A6 (`/v1/auth/otp/*`) is unchanged. | spec §11.3 A18, D28, D29 |
| D40 | Supabase access tokens off by default (stage 7.1d; proposed by the API agent 2026-11-21 for Dawit's approval with stage 7.1) | `SUPABASE_JWT_ACCEPT` now defaults to **false**: there is no Supabase fallback and no Supabase session matters any more (Dawit, 2026-11-21). The dual-token verifier, `SUPABASE_JWT_ACCEPT_UNTIL` and `POST /v1/auth/exchange` stay; they work again only with an explicit `SUPABASE_JWT_ACCEPT=true`. The test setups (`test/support/worker-env.ts`, `src/testing/unit-env.ts`) set it to true explicitly, because the suites and the parity tests sign callers with Supabase-style test tokens; `test/int/supabase-tokens-default.int-spec.ts` proves the default. Supersedes "(default)" in D27. | D27, D35, epic §16 |
| D41 | Re-invite after a finished invite (gap 7; proposed by the API agent for Dawit's approval; approved by Dawit 2026-11-21) | **A deliberate divergence from the SQL functions.** Before the preview claim and the accept write, the API releases the caller's FINISHED rows of the same circle: lookup status `canceled` (declined, or `invite_canceled_at` set, e.g. an invite the owner canceled after the person had previewed it) or `expired` (a pending row the person claimed and let expire). Release = `user_id = null, updated_at = now()`; status, names, phone, token and times stay as history. Then the new row is claimed / accepted, in the SAME transaction. Live rows are never released: an `active` row → `already_member`; a still-valid pending row claimed by the caller (two live invites) → `duplicate_membership`; the owner row is never touched; rows of other circles are never touched. The SQL `preview_circle_invite` / `accept_circle_invite` are unchanged and still answer 409 `duplicate_membership` here (one decline or one cancel-after-preview blocked that person from that circle for good). **Locks** (no deadlock with accept, decline, cancel, remove, leave, submit, the incoming-list claim, or the SQL functions; race tests in `test/int/invites-reinvite-d41.int-spec.ts`): (1) the caller's invitee advisory lock `pg_advisory_xact_lock(4402, hashtext(user_id))`, taken first by the API's preview, accept, decline and `GET /v1/me/invites` (one caller's invitee transactions run one after the other; owner writes, remove, leave and submit never take it); (2) the token's `safety_circles` row `FOR UPDATE` (D18: circle before member rows; the API preview now takes it too, the SQL preview does not); (3) in ONE `ctid`-ordered statement, the token's member row, the caller's non-active rows of the circle and the circle's unclaimed stored-`pending` rows (every row a writer without the circle lock could turn into the caller's while this runs, so the release never meets a unique-index wait cycle); never the owner row or `active` rows (SOS submit takes those `FOR KEY SHARE`, D14). That statement, and the API incoming-list claim's row lock, use `FOR UPDATE NOWAIT` in a savepoint, retried after a short jittered pause on 55P03 (the savepoint rollback frees the rows that attempt had locked; after 5 s of retries the last attempt waits normally): the API never waits for one member row while holding another. Reason (found under full-suite load): the SQL `list_my_circle_invites` locks as its sequential scan goes, and a concurrent UPDATE (a cancel, a release) can move a tuple so that its order differs from the API's `ctid` order; a waiting multi-row lock then deadlocked (40P01). The accept audit row gets `released_finished_rows` when D41 released any. No schema change, no app-visible shape change. Listed in `docs/phase2_parity_checklist.md` ("Deliberate divergences") and `docs/phase2_handoff.md` §7. | spec §7.3, §11.3 I7/I8, rule 22, D18, epic API-100-29/30 |
| D42 | Retire the Supabase app paths (stage 7.6, API-100-62 AC1, AC2, AC4; proposed by the API agent for Dawit's approval; plan approved by Dawit 2026-11-22) | Migration `0012_retire_supabase_app_paths.sql` closes every Supabase path into the data (the app uses none since 7.3d-2; the API connects as the database owner and is unaffected): (1) every table / column privilege of `anon`, `authenticated` and PUBLIC on the `public` relations is revoked (found: `anon` ALL on `profiles`, `safety_circles`, `safety_circle_members`; `authenticated` ALL on those three, SELECT + MAINTAIN on `app_config`, SELECT + UPDATE on `incident_deliveries`, SELECT on `incidents` and `incident_events`: 54 grants); (2) EXECUTE of `anon`, `authenticated` and PUBLIC on every `public` function not owned by an extension is revoked (found: 8 functions for `anon`, 40 for `authenticated`, 5 trigger functions with the default PUBLIC grant: 53 grants). **The functions stay for one release** (AC1) and are dropped by a later migration; triggers keep firing; the owner and `service_role` keep EXECUTE; (3) `incidents` and `incident_events` leave the `supabase_realtime` publication (guarded; the publication stays); (4) the `avatars` Storage write policies of `authenticated` (`avatars_insert_own`, `avatars_update_own`, `avatars_delete_own`) are dropped: the API's Storage service key is the only writer (AC4); public read (`avatars_select_public`, public bucket) stays. Not touched: RLS policies, the functions, the `auth` schema (the custom access token hook and Supabase Auth sign-ups are switched off in the Supabase project config by the coordinator, AC3; the FK repoint of AC3 was D37), `service_role` grants, schema USAGE, default privileges. **Exact rollback:** 0012 first records every grant, publication member and policy it removes in `public.api_retired_supabase_access` (owner only, RLS on); `db/rollback/0012_down.sql` replays that record, drops the table and unrecords 0012 (`test/int/rollback-0012.int-spec.ts`: snapshot before 0012 equals snapshot after the rollback). 0012 ends with a self-check and fails, changing nothing, if any such privilege is left. **Test harness only:** the parity suites and integration files that call the old SQL functions as `authenticated` keep working because the throwaway test template, and only it, re-grants exactly the recorded table / column / function privileges (`test/support/test-harness-grants.ts`, run by `global-setup.ts`); the production state is frozen first and checked by `test/int/production-state.int-spec.ts` (no Supabase privileges, publication members or avatars write policies; Supabase-style calls refused with 42501; the API end to end: sign-up, profile, circle, invite + join, SOS, responder list, mark safe). Parity stays 267/267. Apply on staging and roll back: `docs/phase7_handoff.md` §7.6. | spec §4.4, §7.6, §9; epic API-100-62; D37 |
| D43 | SendGrid email adapter, off by default (stage 7.7a; proposed by the API agent 2026-11-22 for Dawit's approval) | A real email adapter behind the existing `EmailSender`: **`CHANNEL_EMAIL_ADAPTER=fake\|sendgrid`, default `fake`** (with the default nothing changes). `sendgrid` = SendGrid v3 Mail Send, `POST {SENDGRID_API_BASE_URL}/v3/mail/send` (default `https://api.sendgrid.com`; only tests point it at a local fake server; production refuses a non-https URL), `Authorization: Bearer {SENDGRID_API_KEY}` (SECRET, "Mail Send" permission only), JSON body: one recipient in `personalizations`, `from` = `EMAIL_FROM_ADDRESS` (+ optional `EMAIL_FROM_NAME`, no line breaks or `<>"`), the subject, one `text/plain` part, and **click and open tracking switched off** (the auth links carry a single-use token and a custom scheme: no tracking redirect, no pixel). `sendgrid` is refused at startup without `SENDGRID_API_KEY` and `EMAIL_FROM_ADDRESS`. Answers (D24 codes, the style of the other real adapters, shared `FetchTransport` with `NOTIFICATIONS_SEND_TIMEOUT_MS`): 2xx (SendGrid answers 202) → `sent`, `provider_message_id` = the `X-Message-Id` header; 400 naming `personalizations.N.to` → `invalid_recipient`; any other 4xx → `invalid_request` (both permanent, not retried); 401/403 → `auth_failed`, 429 → `rate_limited`, 5xx → `provider_unavailable`, network failure → `transport_error`, no answer in time → `timeout` (retried, as D24/D25 classify them). Every email goes through the selected adapter: the auth links (verification, magic link, password reset; `AuthMessenger`, after the commit, never failing the request) and any notification email (delivery worker, D25 retries; incident notices use push only today, D26, so in practice SendGrid would carry the auth emails). `CHANNEL_EMAIL_ENABLED` still decides whether anything is sent. **Production:** `CHANNEL_EMAIL_ENABLED=true` is now allowed only with `CHANNEL_EMAIL_ADAPTER=sendgrid` and its keys (before: always refused, D24); the fake adapter and the test mailbox (`AUTH_TEST_MAILBOX_ENABLED`) stay refused; the test mailbox only ever reads the fake adapter. The key, recipient addresses and email texts (which hold link tokens) never appear in a result, an error or a log (results carry a message id or a code; the config names keys, never values; the startup line says `mail=fake\|sendgrid`). Tests: unit (request, headers, every answer, against a fake transport), config validation, and `test/int/email-sendgrid.int-spec.ts` against a local fake SendGrid HTTP server (202, 400, 401, 429, 500, timeout, closed port; the three auth emails; a notification email retried 429 → 500 → 202 and a permanent 400). No test reaches the real SendGrid. Not switched on anywhere: no SendGrid account or domain yet; switching it on, sender authentication and the later https App Links (gap 14): `docs/phase7_handoff.md` §7.7a. Supersedes "email: the fake only" and the production email refusal of D24. | spec §11.6, D24, D25, D28, D33; epic API-100-46 |

### 18.1 Working product assumptions (pending PO confirmation)
Dawit will confirm these with the product owner. Build foundations to these assumptions; they affect future epics, not Epic 100 parity.

| # | Conflict | Working assumption |
|---|---|---|
| P1 | Removed/left members and incident history (SCRUM-64) vs the membership access window | The window wins: after leaving or removal a member sees **no** incidents of that circle, including history. |
| P2 | SCRUM-73 grace period vs cancelled SCRUM-42 | **No countdown.** Safeguards = Cancel before a type is chosen + duplicate/idempotent submit. |
| P3 | SCRUM-63 "Closed" state | Use the existing `resolved` status; clients label it "Closed". |
| P4 | SCRUM-70 offline queueing vs fail-fast | **SOS and mark-safe fail fast** (never queued). Queueing only for non-emergency writes (e.g. notes). |
| P5 | SCRUM-68 vs an `unavailable` ping clearing stored coordinates | An `unavailable` report **never wipes** the last known position or its timestamp. |
| P6 | SCRUM-21 contradictory text | Not built until the PO rewrites it. |
| P7 | SCRUM-52 resident phone for "Call resident" | Add a share flag for the resident's own phone during an incident, **off by default**, like the other share flags. |
| P8 | "Arrived" responder status | Out of scope until a story defines it. |
| P9 | SCRUM-33 text vs redesign | Follow the Incoming/Outgoing redesign; PO to update the story text. |
