# Phase 4 hand-off: realtime (API-100-43)

Written 2026-11-20 for the mobile epic that moves the whole app to the Atlas API in one switch (D13,
epic §18). The API side of Phase 4 (stories 39-42) is built and passed its gate (evidence: the
gateway test `test/int/realtime-gateway.int-spec.ts`, the room test
`test/int/realtime-rooms.int-spec.ts`, the broadcast test `test/int/realtime-broadcasts.int-spec.ts`,
the user-room test `test/int/realtime-user-rooms.int-spec.ts`, the gate test
`test/int/realtime-privacy.int-spec.ts` (privacy over a whole incident and the reconnect contract),
all on two API instances sharing one Redis, and the load check `npm run load:realtime`). There is no
per-area switch: this note is input for the single mobile epic after Phase 7, in the structure of
`docs/phase1_handoff.md` to `docs/phase3_handoff.md`. Decisions D19-D21 (epic §18, spec §16) are
proposed with this phase.

Nothing here changes how the app works today. Supabase Realtime (`postgres_changes`) and the SQL
functions stay until Phase 7. Under D13 there is no Supabase fallback in the app: once switched, the
app's own REST polling is the only fallback while the socket is down (section 2).

## 1. Repository method to realtime replacement

The socket uses the API host and Socket.IO 4 (protocol v5 / Engine.IO 4; in Dart a client that speaks
it, e.g. `socket_io_client` in its Socket.IO 4 line).
The same contract is published as data under `x-realtime` in `openapi.json`.

```
io('<api base url>/v1/realtime', OptionBuilder()
    .setTransports(['websocket'])        // websocket only (D19)
    .setPath('/socket.io')
    .setAuth({'token': <access token>})  // the same token as the REST Authorization header
    .disableAutoConnect()
    .build())
```

One socket per signed-in app (not per screen). Every socket is in its own user room (`user:{id}`)
from the moment it connects; incident rooms need `incident.join`.

| Today (method / mechanism) | Realtime replacement | When | Payload (snake_case) | Notes |
| --- | --- | --- | --- | --- |
| `watchIncidentRow({incidentId, onRow})` (`ProfileRepository`; Supabase channel `incident:{id}`, `postgres_changes` on `incidents`, `newRecord` merged by `IncidentDetailsScreen`) | emit `incident.join {incident_id}` (ack), then listen to `incident.updated`; on close emit `incident.leave {incident_id}` | member Incident Details while `active`; keep the room after the flip to `resolved` (as today) | `incident.updated`: `{incident_id, incident: {16 keys}, updated_at, occurred_at}`; the 16 keys are the 15 the screen merges today plus `location_sharing_ended_at` | Merge `incident` exactly as `newRecord` today. **No `resident_id`, `circle_id` or legacy columns** any more (spec §9 sent the whole row). `share_payload` is `{}` when null, as in REST details. Join ack: `{ok: true}` or `{ok: false, error: {code: "get_incident_details:not_found"}}` (same rule as `GET /v1/incidents/{id}`: show the "not available" state) |
| (same screen) | optional finer events: `incident.location`, `incident.notes`, `incident.resolved` | after each location ping / note change / mark safe | `incident.location`: `{incident_id, location_source, location_lat, location_lng, location_accuracy_m, location_captured_at, updated_at, occurred_at}`; `incident.notes`: `{incident_id, incident_notes, incident_notes_updated_at, updated_at, occurred_at}`; `incident.resolved`: `{incident_id, status, resolved_at, resolved_reason, location_sharing_ended_at, updated_at, occurred_at}` | Each write also sends `incident.updated`, so the screen can use `incident.updated` alone; the finer events avoid re-rendering the whole view |
| (same screen, SCRUM-21) | `incident.shared_info_updated` (D53) | after the resident changed their shared emergency info during the active incident | `{incident_id, share_payload, updated_at, occurred_at}`: `share_payload` = the live shared info (allergies / conditions arrays of strings), `updated_at` = when it last changed | Replace the shared section and show "Updated [time]". `GET /v1/incidents/{id}` returns the same live `share_payload` plus `share_payload_at_activation` and `share_payload_updated_at` (reload after a reconnect); `incident.updated` also carries the live `share_payload` |
| (same screen, SCRUM-49/50/51/55) responder list `GET /v1/incidents/{id}/responders` | `incident.responders` (D56) | after a member's first acknowledge or a change of their response (responding / unable) | `{incident_id, responder: {user_id, display_name, avatar_url, status, acknowledged_at, status_at, is_me}, occurred_at}`: the changed row exactly as the list shows it to this receiver | Replace the row with the same `user_id` (masked ids are stable per member) and re-sort (responding, acknowledged, unable, no response; each oldest first). Re-fetch the list after a reconnect. Not sent for a repeat |
| `incidentDeliveryCounts(id)` polled every 2 s by `IncidentStore` (`kDeliveryCountsPollInterval`) while the resident's alert is open | listen to `incident.delivery_counts` (no join needed: it goes to the resident's user room) | on submit, re-notify, a member's first acknowledge, and the close | `{incident_id, delivered_count, acknowledged_count, status, updated_at, occurred_at}` (the REST `DeliveryCounts` keys plus the times) | Stop the 2 s timer while the socket is connected; read the counts once over REST after every (re)connect (section 2) |
| `getMyOpenIncident` re-read on resume | unchanged (REST) | on resume and after every reconnect | — | The resident may also join their own incident (`incident.join`, ack ok) to get `incident.updated` / `incident.resolved` written by another device |
| `listResponderIncidents` re-fetched on screen open / pull | listen to `incident.incoming` and `incident.renotified` on the user room, then re-fetch the list (or insert the summary) | a member with the app open, when someone in their circles raises (`incoming`) or re-sends (`renotified`) an alert | `incident.incoming`: `{incident_id, resident_name, emergency_type, activated_at, sent_at, updated_at, occurred_at}`; `incident.renotified`: `{incident_id, renotified_at, updated_at, occurred_at}` | Recipients are the alert's delivery rows (D14) still inside the window when sent: never the resident, pending invitees, removed members, members who joined after the alert started, or outsiders. Push (Phase 5) covers the closed app |
| Circles I've Joined "Active incident" label (SCRUM-81, D45) reloaded on screen open | listen to `incident.resolved` on the user room (D48) and reload `GET /v1/me/joined-circles` quietly | mark safe of an alert the member received (or the resident's own, on their other devices), even when they never opened it | `incident.resolved`: `{incident_id, status, resolved_at, resolved_reason, location_sharing_ended_at, updated_at, occurred_at}` (same as in the incident room) | One broadcast to the incident room, each recipient's user room and the resident's user room: a socket gets it once even if it also joined the incident. Recipients: as `incident.incoming` (still inside the window) |
| An open alert-details screen or Member View of a circle the user was removed from / left (today: errors on the next read) | listen to `circle.membership_ended` on the user room (D49) | right after a remove or leave of an ACTIVE membership commits (after the D20 eviction) | `{circle_id, occurred_at}` (`occurred_at` = the stored `ended_at`) | Switch every open screen of that `circle_id` (alert details of its incidents, Member View) to "This Safety Circle is no longer available to you." and reload the lists. No reason and no names. Reaches every socket of that user (the leaver's other devices too); never the owner or other members; not sent when a pending / declined invite is removed |
| none today (events read over REST, API-100-22) | `incident.event` in the incident room | after each `incident_events` row | `{incident_id, event: {id, event_type, occurred_at, actor_id, actor_name, detail}, occurred_at}` | Same privacy as `GET /v1/incidents/{id}/events`: members never get `detail.recipient_ids` (D3) and see `actor_id` masked except their own id (D11); the resident sees all. Foundation for timelines (SCRUM-60/61/82) |

Every server event carries `incident_id` and `occurred_at`; row events also `updated_at` (D21).

## 2. Shape changes the app must handle

| Change | What the API sends / expects | What the app should do |
| --- | --- | --- |
| **Reconnect contract** (AC1) | Nothing is replayed after a reconnect (no connection-state recovery) and the new socket is in **no** incident room (rooms are per socket). Events sent while the socket was down are lost for that socket by design. | On every `connect` (first and re-): re-fetch over REST what the visible screens show (`GET /v1/me/incidents/open`, `GET /v1/incidents/{id}/delivery-counts`, `GET /v1/incidents/{id}`, the responder list), then `incident.join` again for the incident on screen. Apply events only after that fetch. |
| **Fallback while the socket is down** (D13) | — | While disconnected, keep today's REST polling as the app's own fallback (counts every 2 s for the resident's open alert; re-fetch details on resume) and stop it once connected again. There is no Supabase path. |
| **Stale events** | `occurred_at` is the database time at which the server read the state it sends (D21): a later `occurred_at` never carries older state. `updated_at` is the row's `updated_at` (the write's transaction time; two overlapping writes can commit in the other order). | Per incident and event kind, drop an event whose `occurred_at` is older than the last one applied. Compare timestamps as instants (`DateTime.parse`), not strings. |
| **Join is re-checked every time** | `incident.join` answers `not_found` for anyone outside `incident.memberView` (and the resident's own incident is always ok). A member removed or who leaves is taken out of the circle's incident rooms at once, on every instance (no event is sent about it). | On a `not_found` ack show the same "no longer available" state as a REST 404. After a remove/leave the app re-fetches anyway. |
| **Other join acks** | `validation:invalid_request` (no uuid `incident_id`), `rate_limit:exceeded` (more than 60 joins per socket per minute), `internal:error` (the server could not check). | Client bugs or transient: retry the join once after a short wait, else fall back to REST polling for that screen. |
| **Session** | Missing, invalid or expired token: `connect_error` with `message` and `data['code']` = `auth:session_expired`. A token that the server could not check (key server down): `internal:error` (retry later; never sign out for it). At the token's `exp` the server sends `session.expired` `{code: "auth:session_expired"}` and disconnects (`io server disconnect`); Socket.IO does **not** reconnect by itself after a server disconnect. | Refresh the access token (the Supabase SDK until Phase 6, own refresh after), set the new token in `auth`, and connect again. On `auth:session_expired` at connect: refresh once; if refresh fails, the normal session-expired flow. |
| **Transport** | Websocket only; long-polling is refused (D19). | `setTransports(['websocket'])`. |
| **Generated client** | The Dart REST client (`clients/dart`) has no socket code; `openapi.json` → `x-realtime` lists events, rooms and payload keys. | Hand-write the small socket service from section 1 (no generator for Socket.IO). |

## 3. Client timeouts and measured latency

Today: the counts poll every 2 s; `postgres_changes` has no client timeout. Suggested for the socket:
connect timeout 10 s, join ack timeout 10 s (then REST fallback), reconnect with backoff 1 s to 30 s
plus jitter.

Measured on the built app, two instances (section 4): ping request start (resident's
`POST /v1/incidents/{id}/locations`) to `incident.location` arriving at every socket of the room,
over 3,000 deliveries: **p50 46.2 ms, p95 71.0 ms, p99 244.9 ms, max 460.0 ms**. 200 joins
answered in 644 ms in total (sent together). REST under the same load: location ping p50 39.6 ms,
p99 178.9 ms; submit p99 364.4 ms; mark safe p99 278.4 ms.

## 4. Load check (AC3)

`npm run build && npm run load:realtime` (about 4 minutes; Docker must be running). Shared harness
(`test/load/load-harness.ts`): throwaway Postgres 17.11 and Redis containers (random ports and
password; the local compose database is not touched; removed afterwards), **two** `node dist/main.js`
instances on spare ports with one throwaway JWT secret, the default settings and rate limits, nothing
from `.env`. 40 residents with 4 active members each (200 users, one socket each, alternating
instances so every incident room spans both); every resident submits (alternating instances), every
socket joins its incident; 180 s steady state with one location ping per incident every 12 s
(staggered, alternating instances); then every resident marks safe. It fails on any lost, duplicated
or foreign event (each socket must get exactly one `incident.location` and one `incident.updated` per
accepted ping of its own incident, none of any other incident, and `incident.resolved` at the end),
any failed request, or any app error log line on either instance.

Result of the final run on 2026-11-20 (Windows laptop, Docker Desktop, built app, default pool of 10
connections per instance): **200 sockets on 2 instances, 40 incidents, 180 s; 200 joins ok, 600 pings
accepted, 3,000 of 3,000 `incident.location` delivered (and 3,000 `incident.updated`); 0 lost, 0
duplicated, 0 foreign, every socket got `incident.resolved`; 0 failed requests, 0 app error log
lines.**

| Route | Requests | Errors | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| POST /v1/incidents | 40 | 0 | 272.1 | 357.9 | 364.4 | 364.4 |
| POST /v1/incidents/:id/locations | 600 | 0 | 39.6 | 59.1 | 178.9 | 331.9 |
| POST /v1/incidents/:id/mark-safe | 40 | 0 | 219.5 | 264.2 | 278.4 | 278.4 |

Each broadcast costs one short read-only query after the commit (the event reads the committed row);
size `DATABASE_POOL_MAX` with that in mind (about one extra query per write).

## 5. Auth notes

- The handshake token is the REST access token (Supabase until Phase 6; own tokens and the one-time
  exchange arrive with Phase 6, D8). It goes in `auth`, never in the URL or a query string; the API
  never logs it.
- The server checks the token once at connect and disconnects at its `exp`; a refreshed token needs a
  new connection (section 2). Expect a reconnect about once per access-token lifetime (1 h today).
- Authorization is per join, with the REST rules: resident (any status) or a member passing
  `incident.memberView` (active member row with `activated_at` not after the incident's
  `activated_at`, status `active`/`resolved`). Removal and leaving revoke at once on every instance.

## 6. Checks before the switch

- [ ] **Redis for the adapter**: the hosted Redis (`REDIS_URL`) must allow pub/sub (`PUBLISH`,
      `PSUBSCRIBE`, `SUBSCRIBE`); a managed Redis with these commands disabled breaks cross-instance
      delivery. All instances of one environment use the same `REALTIME_ADAPTER_KEY` (default
      `atlas:realtime`); staging and production must not share a Redis with the same key.
- [ ] **Load balancer / proxy**: allows WebSocket upgrades on `/socket.io/` (HTTP/1.1 `Upgrade`,
      idle timeout above the Socket.IO ping interval of 25 s + 20 s timeout). No sticky sessions
      needed (websocket only).
- [ ] **`/readyz`** now also fails with `realtime` when the adapter's Redis is down; the platform's
      readiness probe should keep using it.
- [ ] **Pool size**: about one extra read per incident write (section 4); check
      `DATABASE_POOL_MAX` per instance against the hosted connection limit.
- [ ] Replace `watchIncidentRow` and the 2 s counts poll (section 1); keep the poll only while the
      socket is disconnected (section 2); remove the `supabase_realtime` subscription code.
- [ ] **Supabase Realtime stays** until Phase 7 (old app versions use it); the publication is not
      changed by the API.
- [ ] API deployed with production config, `/readyz` green on every instance; Dawit's manual QA (the
      Phase 4 Git Bash guide, two instances) passes.

## 7. Known differences from today (each decided)

| Difference | Decision |
| --- | --- |
| `incident.updated` carries only the 16 merged keys (today the whole row: `resident_id`, `circle_id`, legacy columns); `share_payload` `{}` when null. | API-100-41 AC1, spec §11.5, **D21**. |
| Members get `incident.event` with D3/D11 applied (today `incident_events` were not streamed at all). | API-100-41, **D21** (D3, D11). |
| The resident gets counts pushed (today a 2 s poll), also on the close. | API-100-41 AC1, **D21**. |
| Members with the app open get `incident.incoming` / `incident.renotified` (today nothing: the list is re-fetched on open). | API-100-42, **D21**. |
| The socket is closed at the token's `exp` (Supabase Realtime kept a channel open across refreshes). | API-100-39 AC4, **D19**. |
| Removal or leaving takes the member out of the incident rooms at once (Supabase Realtime stopped sending rows the member could no longer SELECT); a removal through the old app's SQL functions does not evict a live API socket, the next join is refused. | API-100-40 AC3, **D20** (sockets exist only once the app uses the API, D13). |
| Events are not replayed after a reconnect and rooms are per socket (join again). | API-100-43 AC1, **D19**. |
| `/readyz` lists the extra check `realtime`. Not visible to the app. | API-100-39 AC5, **D19**. |
| `incident.resolved` also reaches the user rooms of the recipients and the resident (before: the incident room only), so the Circles I've Joined label clears live. | Gap 17, **D48** (2026-11-23). |
| A removed or leaving member gets `circle.membership_ended {circle_id, occurred_at}` on their user room (new event). | Gap 19, **D49** (2026-11-23). |
| Members see the responder list and `incident.responders` (names, photos, statuses, times, user ids masked as D11); before, members could not see who else was alerted. | SCRUM-49/50/51/55, **D56** (2026-11-23). |
