# Phase 2 hand-off: circles and invites (API-100-33)

Written 2026-11-20 for the mobile epic that moves the whole app to the Atlas API in one switch (D13,
epic §18). The API side of Phase 2 (stories 24-32) is built and passed its gate (evidence: the
checklist in `docs/phase2_parity_checklist.md`, the error-code test
`test/int/phase2-error-codes.int-spec.ts`, the mixed-writer test
`test/int/phase2-mixed-writers.int-spec.ts`, the capacity sweep
`test/int/phase2-capacity-sweep.int-spec.ts`, the activation test
`test/int/membership-activation-routes.int-spec.ts` and the load check `npm run load:circles`).
There is no per-area switch: this note is input for the single mobile epic after Phase 7, in the
structure of `docs/phase1_handoff.md`.

Nothing here changes how the app works today. The SQL functions stay deployed until Phase 7.

## 1. Repository method to endpoint

All routes are under the API base URL, JSON bodies are snake_case, every route except the public
lookup needs `Authorization: Bearer <access token>` (the Supabase access token the app already
holds; the API accepts Supabase tokens until Phase 6). The generated Dart client (`clients/dart`)
has one method per `operationId`; for Phase 2 the operationIds are the repository method names.

Today all 16 methods live in `ProfileRepository` (`mobile/lib/profile/profile_repository.dart`) and
are called by `CirclesStore` (`mobile/lib/state/circles_store.dart`). "Today" below is how each one
is called now.

| Method (today) | Endpoint (operationId) | Body / path | Extra headers | Success | Parity error codes (HTTP) |
| --- | --- | --- | --- | --- | --- |
| `fetchOwnCircle(ownerId)` (table `safety_circles` SELECT `owner_id = uid`, `maybeSingle`; then `listCircleMembers` + `circleInviteCapacity`) | `GET /v1/me/circle` (`fetchOwnCircle`) | none (the caller is the token's user; no `ownerId`) | none | 200 `{circle: {id, owner_id, name, created_at, updated_at} \| null, members: Member[] (owner view), capacity: Capacity \| null}` | `safety_circles:not_authenticated` (401) |
| `listCircleMembers(circleId)` (RPC `list_circle_members`) | `GET /v1/circles/{circle_id}/members` (`listCircleMembers`) | path `circle_id` | none | 200 Member[] (owner view adds `phone, email, relationship, invite_expires_at, invite_consumed_at, invite_canceled_at`; never `invite_token`) | `list_circle_members:not_authenticated` (401), `:not_found` (404), `:not_authorized` (403) |
| `circleInviteCapacity()` (RPC `circle_invite_capacity`) | `GET /v1/me/circle/capacity` (`circleInviteCapacity`) | none | none | 200 `{limit, active_count, pending_count, used, available}` | `circle_invite_capacity:not_authenticated` (401), `:not_owner` (403) |
| `inviteCircleMemberByPhone({displayName, phone, relationship?})` (RPC `invite_circle_member_by_phone`; `relationship` sent only when non-blank) | `POST /v1/me/circle/invites/phone` (`inviteCircleMemberByPhone`) | `{"display_name", "phone", "relationship"?}` (same keys as the RPC; keep omitting a blank relationship) | `Idempotency-Key: <UUID v4>` optional (recommended) | **201** MemberInvitePayload `resent: false` (new row); **200** `resent: true` (the phone's row was refreshed) | `invite_circle_member_by_phone:not_authenticated` (401), `:profile_not_found` (404), `:location_sharing_disabled` (409), `:circle_not_found` (404), `:invalid_display_name` (422), `:invalid_phone` (422), `:invalid_relationship` (422), `:already_active` (409), `:circle_full` (409), `:duplicate_membership` (409) |
| `inviteCircleMembersByPhone(invites)` (RPC `invite_circle_members_by_phone`, param `p_invites`) | `POST /v1/me/circle/invites/phone/batch` (`inviteCircleMembersByPhone`) | `{"invites": [{"phone", "display_name"}]}` (**key renamed** from `p_invites`) | `Idempotency-Key` optional (recommended) | 200 `{created, skipped, not_created, available_after}` (per-item outcomes as today) | `invite_circle_members_by_phone:not_authenticated` (401), `:profile_not_found` (404), `:location_sharing_disabled` (409), `:circle_not_found` (404), `:invalid_invites` (422) |
| `createCircleInviteLink({displayName?})` (RPC `create_circle_invite_link`; no params when the name is blank) | `POST /v1/me/circle/invites/link` (`createCircleInviteLink`) | `{"display_name"?}` (blank or missing → `Invited member`) | `Idempotency-Key` optional, **strongly recommended** (each call reserves a slot) | **201** MemberInvitePayload (`phone: null`, `resent: false`) | `create_circle_invite_link:not_authenticated` (401), `:profile_not_found` (404), `:location_sharing_disabled` (409), `:circle_not_found` (404), `:circle_full` (409) |
| `resendCircleInvite(memberId)` (RPC `resend_circle_invite`) | `POST /v1/me/circle/invites/{member_id}/resend` (`resendCircleInvite`) | path `member_id`, no body | none | 200 MemberInvitePayload `resent: true` (new token; the old link then looks up as `not_found`) | `resend_circle_invite:not_authenticated` (401), `:profile_not_found` (404), `:location_sharing_disabled` (409), `:circle_not_found` (404), `:member_not_found` (404), `:not_invitable` (409), `:already_active` (409), `:circle_full` (409). (`:invalid_display_name` is in the spec but cannot occur, section 7.) |
| `cancelCircleInvite(memberId)` (RPC `cancel_circle_invite`; throws if `canceled` is not true) | `POST /v1/me/circle/invites/{member_id}/cancel` (`cancelCircleInvite`) | path `member_id`, no body | none | 200 `{member_id, circle_id, status: "canceled", owner_name}` | `cancel_circle_invite:not_authenticated` (401), `:not_found` (404), `:not_authorized` (403), `:cannot_cancel_owner` (409), `:not_pending` (409) |
| `removeCircleMember(memberId)` (RPC `remove_circle_member`; throws if `removed` is not true) | `DELETE /v1/circles/{circle_id}/members/{member_id}` (`removeCircleMember`) | path **`circle_id`** and `member_id` (D15) | none | 200 `{member_id, circle_id, removed: true}` | `remove_circle_member:not_authenticated` (401), `:not_found` (404, also a row of another circle, D15), `:not_authorized` (403), `:cannot_remove_owner` (409) |
| `lookupCircleInvite(token)` (RPC `lookup_circle_invite`, anon allowed) | `GET /v1/invites/{token}/status` (`lookupCircleInvite`) | path `token` | **none needed** (public); response `cache-control: no-store` | 200 `{status: pending\|expired\|consumed\|canceled\|not_found, invite_expires_at}` | none (blank/unknown → `not_found`); 429 `rate_limit:exceeded` per IP |
| `previewCircleInvite(token)` (RPC `preview_circle_invite`) | `POST /v1/invites/{token}/preview` (`previewCircleInvite`) | path `token`, no body | none | 200 `{status, invite_expires_at, member_id, circle_id, owner_name, invited_at, claimed, recipient_ok, owner_avatar_url}` | `preview_circle_invite:not_authenticated` (401), `:duplicate_membership` (409) |
| `acceptCircleInvite(token)` (RPC `accept_circle_invite`) | `POST /v1/invites/{token}/accept` (`acceptCircleInvite`) | path `token`, no body | none | 200 `{circle_id, member_id, status: "active", owner_name}` (also on a repeat by the same user) | `accept_circle_invite:not_authenticated` (401), `:not_found` (404), `:expired` (**410**), `:consumed` (409), `:canceled` (409), `:not_recipient` (403), `:own_circle` (409), `:already_member` (409), `:circle_full` (409), `:duplicate_membership` (409) |
| `declineCircleInvite(token)` (RPC `decline_circle_invite`) | `POST /v1/invites/{token}/decline` (`declineCircleInvite`) | path `token`, no body | none | 200 `{circle_id, member_id, status: "declined", owner_name}` | `decline_circle_invite:not_authenticated` (401), `:not_found` (404), `:expired` (**410**), `:consumed` (409), `:canceled` (409, also a second decline), `:not_recipient` (403) |
| `listMyCircleInvites()` (RPC `list_my_circle_invites`) | `GET /v1/me/invites` (`listMyCircleInvites`) | none | none; response `cache-control: no-store` (it carries tokens) | 200 array of `{member_id, circle_id, status, owner_name, invited_at, invite_expires_at, invite_token}` | `list_my_circle_invites:not_authenticated` (401) |
| `listMyJoinedCircles()` (RPC `list_my_joined_circles`) | `GET /v1/me/joined-circles` (`listMyJoinedCircles`) | none | none | 200 array of `{circle_id, name, role, member_id, status, owner_name, joined_at, active_member_count}` (own circle included, as today) | `list_my_joined_circles:not_authenticated` (401) |
| `leaveSafetyCircle(circleId)` (RPC `leave_safety_circle`; throws if `left` is not true) | `POST /v1/circles/{circle_id}/leave` (`leaveSafetyCircle`) | path `circle_id`, no body | none | 200 `{circle_id, member_id, left: true}` | `leave_safety_circle:not_authenticated` (401), `:not_found` (404), `:is_owner` (409), `:not_authorized` (403) |

Not in the table: `fetchCircleMembers(circleId)` (the direct `safety_circle_members` SELECT the store
uses only when `list_circle_members` fails) has **no API equivalent on purpose**: the members come
from `GET /v1/me/circle` (owner view) or `GET /v1/circles/{circle_id}/members`, and the raw table
(with `invite_token` and `activated_at`) is not exposed. Drop the fallback; a failing member list is
the existing "Try again" state.

Every error is the envelope `{"error": {"code": "<fn:code>", "message": "...", "details": {...}}}`.
`error.code` is exactly the string the RPC raised (`PostgrestException.message` today), so
`mapCircleInviteError`, `mapCircleMemberError` and `_rememberInviteStatus` keep working on
`error.code` unchanged (they use `contains`, which the same strings satisfy).

## 2. Shape changes the app must handle

| Change | What the API sends | What the app should do |
| --- | --- | --- |
| **Own circle in one call** (C1) | `GET /v1/me/circle` → `{circle, members, capacity}`; `circle: null`, `members: []`, `capacity: null` when the caller owns no circle. `members` is the owner view of the member list (profile names, `expired` status); `capacity` is the capacity call's body. | Replace the three calls of `loadOwnCircle` (table read, member list, capacity) by this one. `circle` has the same five keys as the table row. A failing call is the existing "Try again" state. |
| **Remove needs the circle** (D15) | `DELETE /v1/circles/{circle_id}/members/{member_id}`; a member of another circle → `remove_circle_member:not_found`. | Pass the listed circle id (the store already requires `listedCircleId` to be the own circle before it removes). |
| **Preview is a POST** | `POST /v1/invites/{token}/preview` (it can claim). `claimed` is `true`/`false`, or **`null`** for an unclaimed row in the `own_circle`, `canceled` and `expired` branches, exactly as the SQL returns it. | Parse `claimed` as `bool?` (as the RPC's JSON already is). |
| **Status codes** | Phone invite: 201 created / 200 refreshed; link: 201; everything else 200. Accept/decline `expired` is **410**. | Treat any 2xx as success and keep reading `resent`. Map errors by `error.code`, never by HTTP status. |
| **Batch body key** | `{"invites": [...]}` instead of the RPC parameter `p_invites`. | Rename the key. |
| **Public lookup** | `GET /v1/invites/{token}/status` needs no token (sending one is harmless), answers `cache-control: no-store`, and is limited per client IP (`rate_limit:exceeded`, 429 + `Retry-After`). | Call it without auth when signed out (deep link before sign-in). On 429 show the generic lookup failure. |
| **Validation 422** (new, no RPC equivalent) | `validation:invalid_request` + `details.field` for a path id that is not uuid input (`circle_id`, `member_id`), a body that is not a JSON object, or a field of the wrong JSON type. PostgREST answered these with a 400 and no `fn:code`. Unknown or blank tokens are not 422: they are `not_found` as today. | A client bug: show the generic failure. The app's own requests never produce them. |
| **Idempotency on invite creation** | Optional `Idempotency-Key` (UUID v4) on phone, batch and link invites: a repeat with the same key replays the stored response (`Idempotent-Replayed: true`, 24 h); same key with another body → 422 `idempotency:key_mismatch`; still running → 409 `idempotency:in_progress` + `Retry-After: 1`. | Send a new UUID per user tap (Send invite, Create link, Send batch); reuse it only to resend the very same request after a lost response (a link created twice reserves two slots). |
| **429 / 500** | `rate_limit:exceeded` (300 / 60 s per user by default); `internal:error` (500) for anything unexpected. | Same as a network error today. |
| **Generated client** | `clients/dart` models: `OwnCircle` (with `SafetyCircle`), `CircleMember`, `Capacity`, `MemberInvitePayload`, `PhoneInviteRequest`, `LinkInviteRequest`, `BatchInviteRequest` / `BatchInviteItem`, `BatchInviteResult` (`BatchInviteSkipped`, `BatchInviteNotCreated`), `InviteLookup`, `InvitePreview`, `AcceptedInvite`, `DeclinedInvite`, `IncomingInvite`, `JoinedCircle`, `RemovedMember`, `LeftCircle`, `CanceledInvite` (as in `openapi.json`). | Map them to the app's existing models (`SafetyCircleRow`, `SafetyCircleMemberRow.fromListRpc`, `CircleInviteResult`, ...); the JSON keys are the ones the app parses today. |

## 3. Client timeouts (spec §7.8) and measured latency

The app caps the own circle, the member list and the capacity at 15 s each (`kCircleLoadTimeout`,
"Try again" on timeout). The invite writes and invitee calls have no client cap today. Measured on
the built app (section 4):

| Call | Client cap | Measured p50 / p95 / p99 (ms) |
| --- | --- | --- |
| `fetchOwnCircle` (`GET /v1/me/circle`, also the steady reload) | 15 s | 42.0 / 223.4 / 557.3 |
| `circleInviteCapacity` | 15 s | 44.8 / 149.5 / 151.4 |
| `listCircleMembers` (owner / member) | 15 s | 17.5 / 38.6 / 44.6 (owner); 228.2 / 303.4 / 337.7 (member, in the accept burst) |
| invite by phone / batch / link | none | 308 / 352 / 364; 364 / 404 / 417; 266 / 747 / 997 |
| resend / cancel | none | 538 / 628 / 640; 535 / 611 / 632 |
| lookup (public) / preview / accept / decline | none | 496 / 586 / 601; 540 / 625 / 634; 547 / 627 / 653; 550 / 628 / 633 |
| incoming / joined circles | none | 64 / 593 / 645; 42 / 244 / 473 |
| remove / leave | none | 21 / 52 / 57; 222 / 245 / 262 |

Every circle call answers far inside the 15 s cap. The 0.5-1 s tails are the synchronized bursts of
the scenario (40 owners and 160 invitees acting in the same second, queueing for the 10 pooled
database connections); steady reloads are tens of milliseconds. Suggestion for the switch epic:
give the invite writes and invitee calls the same 15 s cap as the circle reads.

## 4. Load check

`npm run build && npm run load:circles` (about 1.5 minutes; Docker must be running). It uses the
shared load harness (`test/load/load-harness.ts`, also used by `load:incidents`): its own throwaway
Postgres 17.11 and Redis containers (random ports and password; the local compose database is not
touched, the containers are removed afterwards), `node dist/main.js` on a spare port with a
throwaway JWT secret and the **default** rate limits, `TRUST_PROXY=127.0.0.1` with one
`x-forwarded-for` address per invitee (as behind the production proxy). 40 owners with 4 invitees
each, all at once: owner opens the circle and capacity, invites by phone, batch (one invitee and a
number without an account) and two links; invitees open Incoming, preview, accept or decline, the
link invitees look the link up first, one opens joined circles and the member list and leaves; the
owner resends and cancels the batch invite of the number without an account; 60 s of steady reloads
(owner circle every 5 s, members' joined circles and Incoming every 10 s); the owner lists the
members, removes one and reads the capacity. It fails on any unexpected status, any app error log
line, wrong rows, or a route p99 not under 15 s.

Result of the final run on 2026-11-20 (Windows laptop, Docker Desktop, built app, default pool of 10
connections, default rate limits): **2,272 requests in 64.6 s, 0 errors, 0 app error log lines, row
check ok** (per circle: owner row, one active member with `activated_at`, two declined/canceled
rows; no circle above 5).

| Route | Requests | Errors | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| GET /v1/me/circle | 569 | 0 | 42.0 | 223.4 | 557.3 | 622.0 |
| GET /v1/me/circle/capacity | 80 | 0 | 44.8 | 149.5 | 151.4 | 151.4 |
| POST /v1/me/circle/invites/phone | 40 | 0 | 308.2 | 352.0 | 363.5 | 363.5 |
| POST /v1/me/circle/invites/phone/batch | 40 | 0 | 363.7 | 403.7 | 417.2 | 417.2 |
| POST /v1/me/circle/invites/link | 80 | 0 | 266.0 | 747.1 | 997.0 | 997.0 |
| GET /v1/invites/:token/status (public) | 80 | 0 | 496.2 | 585.9 | 601.1 | 601.1 |
| POST /v1/me/circle/invites/:member_id/resend | 40 | 0 | 537.6 | 627.5 | 640.3 | 640.3 |
| GET /v1/me/invites | 328 | 0 | 63.9 | 593.4 | 645.1 | 652.5 |
| POST /v1/invites/:token/preview | 120 | 0 | 539.9 | 625.2 | 633.5 | 639.7 |
| POST /v1/me/circle/invites/:member_id/cancel | 40 | 0 | 535.1 | 611.4 | 632.3 | 632.3 |
| POST /v1/invites/:token/decline | 40 | 0 | 549.5 | 628.4 | 632.9 | 632.9 |
| POST /v1/invites/:token/accept | 120 | 0 | 547.1 | 626.6 | 652.7 | 673.8 |
| GET /v1/me/joined-circles | 535 | 0 | 42.0 | 244.1 | 472.5 | 512.8 |
| GET /v1/circles/:circle_id/members (member) | 40 | 0 | 228.2 | 303.4 | 337.7 | 337.7 |
| POST /v1/circles/:circle_id/leave | 40 | 0 | 222.0 | 244.7 | 262.4 | 262.4 |
| GET /v1/circles/:circle_id/members (owner) | 40 | 0 | 17.5 | 38.6 | 44.6 | 44.6 |
| DELETE /v1/circles/:circle_id/members/:member_id | 40 | 0 | 21.1 | 52.4 | 57.4 | 57.4 |

## 5. Auth notes

- Until Phase 6 the API accepts the **Supabase access token** the app already has (same header,
  same refresh by the Supabase SDK). Own tokens and the one-time session exchange arrive with Phase
  6 (D8); nothing in this phase depends on them.
- Every authenticated route answers `<fn>:not_authenticated` (401) with its own prefix (table
  above) for a missing, invalid or expired token: the app's session-expired flow, as today.
- `GET /v1/invites/{token}/status` is the only public route of this phase (as `lookup_circle_invite`
  is granted to `anon` today).
- Recipient rule (spec rule 18): a phone invite can be previewed/accepted/declined only by a user
  whose **verified Auth phone** (`auth.users.phone`, normalized) equals the invited number; a link
  invite by anyone holding the token. With SMS on hold (Twilio) nobody can verify a phone, so phone
  invites stay `not_recipient` for every account until SMS is enabled. Same in the SQL today.

## 6. Checks before the switch

- [ ] **Hosted session settings** (read-only): `show timezone;` → `UTC` (the API sets UTC per
      transaction; the JSON timestamp text and the text ordering of section 7 assume it).
- [ ] **Hosted collation** (read-only): `select datlocprovider, datcollate from pg_database where
      datname = current_database();`. Local and test images are ICU `en-US`; the ordering note in
      section 7 is written for that. Under libc the same text order equals time order.
- [ ] **API config of the hosted project**: `SUPABASE_URL` (public avatar URLs are built from it,
      not from the request host as the SQL does), `AVATARS_BUCKET=avatars`,
      `INVITE_URL_BASE=io.supabase.atlasmobile://invite/` (the default; the app parses links of
      this form), `TRUST_PROXY` set to the proxy in front of the API (the public lookup is limited
      per client IP; without it every phone shares one limit).
- [ ] **The SQL functions stay deployed** until Phase 7; do not drop or change them.
- [ ] **D14 applies only to the API.** While old app versions submit through the SQL function, an
      SOS racing a leave/remove can still fail there with 23503 (the app shows its failure screen
      with Try Again). It disappears once the app submits through the API.
- [ ] **The RLS bypass closes with the switch.** Today an owner can insert/update member rows
      directly through RLS (spec §4.4); the API has no such route (only accept activates; test
      `membership-activation-routes.int-spec.ts`). Old app versions keep the bypass until Phase 7.
- [ ] Drop the `fetchCircleMembers` fallback (section 1).
- [ ] API deployed with production config, `/readyz` green; Dawit's manual QA of the circles area
      (the Phase 2 Git Bash guide) passes.

## 7. Known differences from the SQL (each decided)

| Difference | Decision |
| --- | --- |
| `GET /v1/me/circle` combines the circle row, the owner member list and the capacity. | Spec §11.3 C1, API-100-24. |
| Remove takes the circle in the path; a member of another circle is `not_found`. | **D15** (2026-11-20, stricter than the SQL). |
| An SOS submit racing a member's leave/remove succeeds (that member is not notified); the SQL function can fail with 23503. | **D14** (2026-11-20, "an SOS must always go through"). |
| Lists order by the timestamp's JSON text, as the SQL (`list_my_circle_invites` by `invited_at` desc, `list_my_joined_circles` by `joined_at` desc). Under the ICU `en-US` collation this differs from strict time order in one case: inside one second, a timestamp with no fraction (`10:00:00+00:00`) sorts as later than every fractional one (`10:00:00.5+00:00`), so in the descending lists the whole-second row comes first. Same order as the SQL on the same database (test in `phase2-mixed-writers.int-spec.ts`). | Note of 2026-11-20 (kept as in SQL, recorded only). |
| Tie-breaks: rows with the same timestamp text are ordered by `member_id` in the API; the SQL leaves their order unspecified. The member list keeps the SQL's full order (owner, status, name, `invited_at`). | API-100-31 (deterministic within the SQL's freedom). |
| Preview is a POST (`claimed` can be null as in SQL). | Spec §11.3 I7, API-100-29 (2026-11-20 decision on `claimed`). |
| Path ids that are not uuid input → 422 `validation:invalid_request` (PostgREST: 400 without a code). | Spec §11.2 validation details. |
| Public lookup is rate limited per IP and answers `cache-control: no-store`; Incoming answers `no-store` too. | API-100-11, API-100-29/31. |
| Invite tokens are never logged (request logs carry the route template `/v1/invites/:token/...`; traces and free text scrub tokens and invite links). | API-100-06, API-100-29. |
| Avatar URLs come from `SUPABASE_URL` + bucket, not from the request `Host` header. | Spec §11.3 P8 note, API-100-25. |
| `resend_circle_invite:invalid_display_name` cannot occur (resend keeps the stored name; the check constraint `safety_circle_members_display_name_nonempty` keeps it non-blank). Same in SQL. | Proven in `phase2-error-codes.int-spec.ts`. |
| The API writes an `audit_log` row per membership and invite write (ids and counts only; never a phone, name or token); the SQL writes none. Not visible to the app. | API-100-14. |
| Phone invites need a verified Auth phone to be accepted (SMS on hold). | Spec rule 18; unchanged from SQL. |
| Re-invite after a finished invite: when a person previews or accepts a new invite to a circle where they hold a finished row (declined; canceled after they previewed it; or an expired invite they had claimed), the API releases that old row (`user_id = null`, kept as history) and claims / accepts the new one in the same transaction. The SQL functions answer 409 `duplicate_membership` here. Live rows are unchanged (`active` → `already_member`; two live invites → `duplicate_membership`). The API preview now also locks the circle first (D18), every API invitee call takes a per-user advisory lock, and the API's multi-row member locks (preview/accept, incoming-list claim) use `FOR UPDATE NOWAIT` with retry, so they never wait for one member row while holding another. | **D41** (approved by Dawit 2026-11-21, deliberate divergence; listed in `docs/phase2_parity_checklist.md`). |
