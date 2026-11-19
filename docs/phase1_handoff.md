# Phase 1 hand-off: incidents and live location (API-100-23)

Written 2026-11-19 for the mobile story that switches `IncidentStore` from the Supabase RPCs to the
Atlas API. The API side of Phase 1 (stories 15-22) is built and passed its gate (evidence: the
checklist in `docs/phase1_parity_checklist.md`, the error-code test
`test/int/phase1-error-codes.int-spec.ts`, the mixed-writer test
`test/int/phase1-mixed-writers.int-spec.ts` and the load check `npm run load:incidents`). The switch
itself is a separate mobile story, after Dawit's manual QA and approval.

Nothing here changes how the app works today. The SQL functions stay deployed until Phase 7, so the
app can go back to them at any time (section 5).

## 1. Repository method to endpoint

All routes are under the API base URL (for example `https://<api host>`), JSON bodies are snake_case,
every route needs `Authorization: Bearer <Supabase access token>` (the same token the app already
holds; the API accepts Supabase tokens until Phase 6). The generated Dart client
(`clients/dart`, package version = API version) has one method per `operationId`.

| `ProfileRepository` method (today's RPC) | Endpoint | Body / query | Extra headers | Success | Parity error codes (HTTP) |
| --- | --- | --- | --- | --- | --- |
| `submitEmergencyAlert` (`submit_emergency_alert`) | `POST /v1/incidents` (`submitEmergencyAlert`) | `{"emergency_type": "<medical\|domestic_violence\|fire\|burglary\|other>"}` | `Idempotency-Key: <UUID v4>` **required** | **201** `created` / `promoted`, **200** `renotified`; body IncidentSend + `submit_outcome` | `submit_emergency_alert:not_authenticated` (401), `:invalid_type` (422), `:profile_not_found` (404), `:profile_setup_incomplete` (409) |
| `getMyOpenIncident` (`get_my_open_incident`) | `GET /v1/me/incidents/open` (`getMyOpenIncident`) | none | none | 200 `{"open_incident": IncidentSend \| null}` (D2) | `get_my_open_incident:not_authenticated` (401) |
| `listMyRecentIncidents` (`list_my_recent_incidents`) | `GET /v1/me/incidents?limit=<n>` (`listMyRecentIncidents`) | `limit` optional (missing → 5, clamped 1-20) | none | 200 array of `{id, emergency_type, status, activated_at, sent_at, resolved_at, resolved_reason}` | `list_my_recent_incidents:not_authenticated` (401) |
| `attachIncidentLocation` (`attach_incident_location`) | `POST /v1/incidents/{id}/locations` (`attachIncidentLocation`) | `{"location_source", "location_lat"?, "location_lng"?, "location_accuracy_m"?, "location_captured_at"?}` (same keys as the RPC without `p_`; omit lat/lng/accuracy/captured_at for `unavailable`, as today) | none | 200 IncidentShared (22 keys); an older fix is 200 with the current row | `attach_incident_location:not_authenticated` (401), `:invalid_source` (422), `:invalid_location` (422), `:not_found` (404), `:not_open` (409) |
| `getLiveLocationConfig` (`get_live_location_config`) | `GET /v1/config/live-location` (`getLiveLocationConfig`) | none | none | 200 `{interval_seconds, stale_threshold_seconds}` | `get_live_location_config:not_authenticated` (401) |
| `renotifyEmergencyAlert` (`renotify_emergency_alert`; not called by the app) | `POST /v1/incidents/{id}/renotify` (`renotifyEmergencyAlert`) | none | none | 200 IncidentSend | `renotify_emergency_alert:not_authenticated` (401), `:not_found` (404), `:not_open` (409) |
| `setIncidentNotes` (`set_incident_notes`; no UI yet) | `PUT /v1/incidents/{id}/notes` (`setIncidentNotes`) | `{"incident_notes": string \| null}` | none | 200 IncidentShared | `set_incident_notes:not_authenticated` (401), `:not_found` (404), `:not_open` (409), `:too_long` (422) |
| `markIncidentSafe` (`mark_incident_safe`) | `POST /v1/incidents/{id}/mark-safe` (`markIncidentSafe`) | none | `Idempotency-Key: <UUID v4>` **required** | 200 IncidentSend (also when already closed as safe: unchanged) | `mark_incident_safe:not_authenticated` (401), `:not_found` (404), `:not_open` (409) |
| `incidentDeliveryCounts` (`incident_delivery_counts`) | `GET /v1/incidents/{id}/delivery-counts` (`incidentDeliveryCounts`) | none | none | 200 `{incident_id, delivered_count, acknowledged_count, status}` | `incident_delivery_counts:not_authenticated` (401), `:not_found` (404) |
| `acknowledgeIncident` (`acknowledge_incident`; not called by the app, Epic 5) | `POST /v1/incidents/{id}/acknowledge` (`acknowledgeIncident`) | none | none | 200 DeliveryCounts | `acknowledge_incident:not_authenticated` (401), `:not_found` (404), `:not_open` (409) |
| `listResponderIncidents` (`list_responder_incidents`) | `GET /v1/responder/incidents` (`listResponderIncidents`) | none | none | 200 array of `{id, resident_name, emergency_type, activated_at, status, sent_at, renotified_at, resolved_at, resolved_reason, auto_closed}` | `list_responder_incidents:not_authenticated` (401) |
| `getIncidentDetails` (`get_incident_details`) | `GET /v1/incidents/{id}` (`getIncidentDetails`) | none | none | 200 IncidentDetails (19 keys, `share_payload` `{}` when null) | `get_incident_details:not_authenticated` (401), `:not_found` (404, also pre-join) |
| none today (foundation for SCRUM-60/61/64/82) | `GET /v1/incidents/{id}/events` (`listIncidentEvents`) | none | none | 200 `[{id, event_type, occurred_at, actor_id, detail}]` ordered `occurred_at, id` | `incident_events:not_authenticated` (401), `incident_events:not_found` (404) |

Not in Phase 1: `watchIncidentRow` stays on Supabase Realtime (`postgres_changes` on `incidents`)
until Phase 4 (API-100-39..43). API writes land in the same table, so that subscription keeps working
after the switch.

Every error is the envelope `{"error": {"code": "<fn:code>", "message": "...", "details": {...}}}`.
The app matches `error.code` exactly as it matches the `PostgrestException` message today (the same
strings), so the mapping functions (`mapSubmitEmergencyAlertError`, `mapMarkIncidentSafeError`,
`mapAttachIncidentLocationError`, `mapSetIncidentNotesError`) keep working on `error.code`.

## 2. Shape changes the app must handle

| Change | What the API sends | What the app should do |
| --- | --- | --- |
| **D2** open incident wrapper | `GET /v1/me/incidents/open` → `{"open_incident": {...}}` or `{"open_incident": null}`, always 200. The RPC returned the bare object or JSON `null`. | Read `open_incident`; null = no open incident (same meaning as today). |
| **Submit status** | 201 for `created`/`promoted`, 200 for `renotified`. | Treat any 2xx as success and keep reading `submit_outcome`, as today. |
| **D3 / D11** on events | For a caller who is not the resident: `detail.recipient_ids` removed from `alert_sent` and `closure_notified`; `actor_id` masked (`4f3a****-****-****-****-********9c2d`), except the caller's own id; null stays null. The resident sees everything. | Nothing today (the app does not read events). Timelines/activity built on this read must not expect other members' ids. |
| **Validation 422** (new codes, no RPC equivalent) | `validation:invalid_request` with `details.field`: a path `{id}` that is not uuid input (`id`), a body that is not a JSON object (`body`), `limit` that is not an integer (`limit`), a location value Postgres cannot convert (e.g. `location_lat`), a non-string `incident_notes`. PostgREST answered these with a 400 and no `fn:code`. The submit body falls back to `submit_emergency_alert:invalid_type`. | A client bug, not a user error: show the generic failure. The app's own requests never produce them. |
| **Idempotency** (submit and mark safe) | Missing key → 400 `idempotency:key_required`; not a UUID → 422 `idempotency:invalid_key`; same key with another body/path → 422 `idempotency:key_mismatch`; same key still running → **409 `idempotency:in_progress` + `Retry-After: 1`**; a repeat of a finished key replays the stored response with `Idempotent-Replayed: true` (stored for 24 h, 2xx and 4xx). | Send a new UUID v4 per user tap (Send, Try Again, I'm Safe Now). Reuse a key only to resend the very same request after a lost response. Treat `in_progress` like a timeout: run the existing `get_my_open_incident` recheck (or wait `Retry-After` and resend with the same key). Never reuse a key after a 4xx you expect to change (it replays the stored 4xx). |
| **429** | `rate_limit:exceeded` + `Retry-After: <seconds>`. Defaults: 300 / 60 s per user on every route, 30 / 60 s per user for submit + mark safe, 30 / 60 s per user per incident for location pings. | Not reachable by the app's normal rhythm (pings every 12 s, counts every 2 s ≈ 36 / min). If it happens: submit / mark safe → the ambiguous-failure path (recheck); pings and counts → skip the tick. |
| **500** | `internal:error` (also when `app_config` holds a non-integer live-location value; the RPC raised too). | Same as a network error today: the ambiguous path (recheck) for submit / mark safe; defaults 12/45 for the config. |
| **Session** | `<fn>:not_authenticated` (401) for a missing, invalid or expired token, on every route. | As today: the session-expired flow. |

## 3. Client timeouts (spec §7.8) and measured latency

| Call | Client cap (app constant) | Measured on the built app, 50 residents (section 4) |
| --- | --- | --- |
| `submitEmergencyAlert` | 12 s (`kEmergencySubmitTimeout`), 0 s offline | p50 509 ms, p95 629 ms, p99 657 ms (all 50 submitted in the same instant) |
| `markIncidentSafe` | 12 s (`kEmergencySubmitTimeout`), 0 s offline | p50 176 ms, p95 218 ms, p99 229 ms |
| `getMyOpenIncident` (recheck) | 3 s (`kEmergencyRecheckTimeout`) | p50 44 ms, p95 64 ms, p99 69 ms |
| `getLiveLocationConfig` | 5 s (`kLiveConfigTimeout`) | p50 334 ms, p99 686 ms (sent in the submit burst) |
| `attachIncidentLocation` | 15 s (`kLiveUploadTimeout`), one upload in flight | p50 22 ms, p95 533 ms, p99 736 ms (all 50 pings land in the same second every 12 s) |
| `incidentDeliveryCounts` | polled every 2 s while open | resident p50 6 ms, p99 241 ms; member p50 7 ms, p99 159 ms |

The API answers every incident call far inside its cap. The caps stay as they are: the measured
numbers are on a local machine, so they leave room for the mobile network and the hosted database
(EU, decision D9). The open-incident recheck (3 s) is the tightest budget.

## 4. Load check (AC4)

`npm run build && npm run load:incidents` (about 4 minutes; Docker must be running). It starts its
own throwaway Postgres 17.11 and Redis containers (Testcontainers, random ports and password; the
local compose database is not touched and the containers are removed afterwards), seeds 50 residents
with complete profiles and 3 active members each, starts `node dist/main.js` on a spare port with a
throwaway JWT secret and the **default** rate limits, and runs: all 50 submit at the same moment,
each resident pings every 12 s for 180 s and polls its counts every 2 s, every member reads the
responder list and details once and polls counts every 2 s, one member per circle acknowledges,
then every resident marks safe and reads open / recent / events. It fails on any unexpected status,
any app error log line, wrong rows, or p99 submit ≥ 2 s.

Result of the final run on 2026-11-19 (Windows laptop, Docker Desktop, built app, default pool of 10
database connections, default rate limits, nothing raised): **19,454 requests in 180.9 s, 0 errors,
0 app error log lines, row check ok** (50 incidents resolved as safe with a stored fix, 150
deliveries, 50 acknowledgements, 300 events), **p99 submit 657 ms** (budget 2 s).

| Route | Requests | Errors | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| POST /v1/incidents | 50 | 0 | 509.3 | 628.5 | 657.3 | 657.3 |
| GET /v1/config/live-location | 50 | 0 | 333.5 | 675.9 | 686.4 | 686.4 |
| GET /v1/incidents/:id/delivery-counts (resident) | 4508 | 0 | 5.9 | 14.6 | 240.5 | 688.6 |
| GET /v1/responder/incidents | 150 | 0 | 347.3 | 575.3 | 580.2 | 582.6 |
| GET /v1/incidents/:id | 150 | 0 | 648.4 | 697.3 | 707.2 | 708.3 |
| POST /v1/incidents/:id/locations | 763 | 0 | 22.2 | 533.4 | 735.7 | 751.1 |
| GET /v1/incidents/:id/delivery-counts (member) | 13533 | 0 | 7.0 | 18.7 | 158.8 | 603.6 |
| POST /v1/incidents/:id/acknowledge | 50 | 0 | 23.6 | 35.3 | 53.1 | 53.1 |
| POST /v1/incidents/:id/mark-safe | 50 | 0 | 175.7 | 218.0 | 229.0 | 229.0 |
| GET /v1/me/incidents/open | 50 | 0 | 43.7 | 63.9 | 69.4 | 69.4 |
| GET /v1/me/incidents | 50 | 0 | 43.7 | 70.0 | 76.0 | 76.0 |
| GET /v1/incidents/:id/events | 50 | 0 | 34.6 | 67.3 | 69.6 | 69.6 |

The slow tail is the synchronized bursts (200 users starting at the same moment, 50 pings in the same
second every 12 s) queueing for the 10 pooled connections; steady polling is single-digit
milliseconds. Production should size `DATABASE_POOL_MAX` with the hosted connection limit in mind.

## 5. Rollback switch (server row from migration 0004; app side is the mobile story)

Goal: the incident area can go back to the Supabase RPCs without a new app release, and the API
path can be turned on gradually.

1. **Seam.** Split the 12 incident methods out of `ProfileRepository` into an `IncidentRepository`
   interface (same method names and result models). `SupabaseIncidentRepository` is today's code,
   unchanged. `ApiIncidentRepository` uses the generated Dart client and maps the envelope's
   `error.code` into the same exception the store already matches (one `IncidentBackendException`
   with `code`, so the `map*Error` functions keep working). `IncidentStore` depends only on the
   interface.
2. **Selector.** `IncidentBackendSelector` returns one of the two. Inputs, first match wins:
   a remote value in `app_config` key `client_incidents_backend` (`"supabase"` or `"api"`; readable
   by every signed-in user through the existing `app_config` SELECT; a new row, no schema change;
   **the row exists from migration `db/migrations/0004_client_incidents_backend_switch.sql` with the
   default `"supabase"`**, and signed-in users can read but not write it),
   else the build default from the app's env file (`INCIDENTS_BACKEND`, plus `ATLAS_API_BASE_URL`).
   Missing or unreadable → `supabase`.
3. **When it applies.** Read at sign-in and on resume, never in the middle of a submit, mark-safe or
   upload. Both paths read and write the same rows, so an open alert carries over: after a flip the
   store runs its normal restore (`getMyOpenIncident`), and counts polling and live location go on
   against the other backend.
4. **Turning on and rolling back.** Run as the service role / `postgres` (ops):
   `update public.app_config set value = '"api"'::jsonb where key = 'client_incidents_backend'`
   to turn the API on, and the same with `'"supabase"'::jsonb` to roll back. Apps pick it up on the
   next resume. The SQL
   functions stay deployed until Phase 7 (API-100-62), so this works for every phase until then.
5. **Safety net in the client.** If the API path fails with a network error / 5xx several times in a
   row for a read, the store may fall back to the Supabase path for that call only; never for submit
   or mark safe (a second, different writer could double an alert). Submit and mark safe keep the
   fail-fast + recheck behaviour.

## 6. Checks before the switch

- [ ] **Hosted session settings** (Dawit, read-only, on the hosted project): `show timezone;` →
      `UTC` and `show datestyle;` → `ISO, MDY`. The API sets both per transaction to these values
      (story 17: a `location_captured_at` without an offset is read as UTC, `01/02/2026` month
      first), which matches PostgREST only if the hosted defaults are these.
- [ ] **`app_config` live-location values are whole JSON numbers > 0**
      (`live_location_interval_seconds`, `live_location_stale_threshold_seconds`). A decimal such as
      `12.5` makes both the RPC and the API fail (the API answers 500).
- [ ] **The SQL functions stay deployed** until Phase 7. Do not drop or change them; they are the
      rollback path (section 5) and are still used by other app areas.
- [ ] **Known SQL deadlocks go away with the switch.** `mark_incident_safe` and
      `renotify_emergency_alert` lock the incident before the profile, `submit_emergency_alert` the
      profile first, so a double tap racing a submit can deadlock (40P01) in SQL. The API's mark
      safe and renotify take a `FOR KEY SHARE` lock on the profile before they lock the incident,
      the same order as submit (tests in `incidents-mark-safe.int-spec.ts` and
      `phase1-mixed-writers.int-spec.ts`, each with the SQL deadlock for contrast). The deadlock can
      still happen while some phones run the old app version; it disappears once the app uses the API.
- [ ] **Realtime story API-100-41 must apply D3 and D11 per recipient** when it broadcasts events
      (`incident.event`): members must not receive `recipient_ids` or another person's full
      `actor_id`.
- [ ] API deployed with production config (JWKS / issuer of the hosted project, `DATABASE_URL`,
      `REDIS_URL`, `TRUST_PROXY` behind a proxy that overwrites `x-forwarded-for`), `/readyz` green.
- [ ] Dawit's manual QA of the incident area against the API passes.

## 7. Known differences from the SQL (each decided)

| Difference | Decision |
| --- | --- |
| `GET /v1/me/incidents/open` always wraps: `{"open_incident": null}` instead of bare `null`. | D2 (epic §18). |
| Members get no `detail.recipient_ids` in events. | D3. |
| Members get a masked `actor_id` in events (own id in full; resident sees all). | D11. |
| Events through the API return 404 `incident_events:not_found` where RLS returned an empty list (no access, unknown id). | API-100-22 (hidden existence, spec §11.2). |
| Request values Postgres cannot convert (path id, `limit`, location values, a body that is not an object, a non-string note) → 422 `validation:invalid_request` + `details.field`. PostgREST answered 400 without a `fn:code`. | Stories 15-18 (spec §11.2 "validation details"). |
| Submit with an unreadable body (not a JSON object, missing or non-string type) → `submit_emergency_alert:invalid_type` (422). | API-100-15 AC2 (null/unknown type is `invalid_type`). |
| `limit` that is not an integer (`abc`, `2.5`, empty, outside int4) → 422 on `limit`. Any integer is clamped 1-20 as in SQL. | API-100-16. |
| A JSON number literal that underflows (`1e-400`) is read as `0` by the API; PostgREST passed the text and Postgres refused it. | API-100-17 (JSON no longer has the literal text). |
| `location_captured_at` as a JSON number is refused (422); PostgREST parsed its digits as a date. | API-100-17 (a choice; the app always sends an ISO string). |
| A non-string `incident_notes` (number, boolean, object) is refused (422); PostgREST stored its JSON text. | API-100-18. |
| `get_live_location_config` with a non-integer number raises in both; the API answers 500 `internal:error`. | API-100-17 (kept as in SQL). |
| `Idempotency-Key` required on submit and mark safe; replays and `in_progress`. | Spec §11.2, API-100-10. |
| Rate limits (429 + `Retry-After`). | API-100-11. |
| API writes an `audit_log` row per incident write; the SQL functions write none. Not visible to the app. | API-100-14. |
| Lock order: the API takes a key-share lock on the profile before the incident in mark safe and renotify (the SQL can deadlock against submit). Same results, no deadlock. | Stories 18-19 (Dawit: leave the SQL as it is). |

## 8. Follow-up for timelines (story 22 decision)

Events written in one transaction share `occurred_at` (Postgres `now()` is the transaction time):
`alert_sent` + `location_sharing_started` at submit, and the four closure events at mark safe. The
events read orders by `occurred_at, id`, and `id` is a random UUID, so inside one transaction the order
is **not** the insertion order (for example `closure_notified` can come before `safe_recorded`).
Behaviour is unchanged for Phase 1 (the app does not read events). Follow-up for the timeline /
activity stories (SCRUM-60/61/82): define a display order for same-time events (for example a fixed
lifecycle rank per type, or an additive `seq bigserial` column written by the event service), and
apply it in the API, not in the client.
