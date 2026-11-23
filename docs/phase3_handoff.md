# Phase 3 hand-off: profile and settings (API-100-38)

Written 2026-11-20 for the mobile epic that moves the whole app to the Atlas API in one switch (D13,
epic §18). The API side of Phase 3 (stories 34-37) is built and passed its gate (evidence: the
checklist in `docs/phase3_parity_checklist.md`, which also shows that no parity test of any SQL file
is `it.todo` any more; the error-code test `test/int/phase3-error-codes.int-spec.ts`; the flow test
`test/int/phase3-flows.int-spec.ts`; the mixed-writer test `test/int/phase3-mixed-writers.int-spec.ts`;
the setup race test `test/int/profile-setup-races.int-spec.ts`; the exposure test
`test/int/profile-exposure.int-spec.ts`; the activation test
`test/int/membership-activation-routes.int-spec.ts`; and the load check `npm run load:profiles`).
There is no per-area switch: this note is input for the single mobile epic after Phase 7, in the
structure of `docs/phase1_handoff.md` and `docs/phase2_handoff.md`.

Nothing here changes how the app works today. The SQL functions and the direct table access stay
until Phase 7.

## 1. Repository method to endpoint

All routes are under the API base URL, JSON bodies are snake_case, every route needs
`Authorization: Bearer <access token>` (the Supabase access token the app already holds; the API
accepts Supabase tokens until Phase 6). The generated Dart client (`clients/dart`) has one method
per `operationId`; for Phase 3 the operationIds are the repository method names, except `fetchOwn`
(`fetchOwnProfile`, so the generated client has no bare `fetchOwn`) and the two new avatar calls.

Today all methods below live in `ProfileRepository` (`mobile/lib/profile/profile_repository.dart`)
and are called by `ProfileStore` (`mobile/lib/state/profile_store.dart`). "Today" is how each is
called now. No route takes a user id: the caller is the token's user (`profile.self`); drop the
`userId` arguments.

| Method (today) | Endpoint (operationId) | Body / path | Extra headers | Success | Error codes (HTTP) |
| --- | --- | --- | --- | --- | --- |
| `fetchOwn(userId)` (table `profiles` SELECT `*` `id = uid`, `maybeSingle`; `null` without a row) | `GET /v1/me/profile` (`fetchOwnProfile`) | none | none | 200 Profile: every `profiles` column in table order, plus `avatar_url` | `profiles:not_authenticated` (401), `profiles:profile_not_found` (**404: today's `null`**) |
| `isPersonalInfoComplete` / `isPreferencesComplete` / `isEmergencyInfoComplete` / `isProfileSetupComplete` (one-column SELECTs) | `GET /v1/me/profile` (`fetchOwnProfile`) | none | none | 200 Profile: `*_completed_at` / `profile_setup_completed_at` not null = complete | as above (404 = not complete) |
| `upsertPersonalInfo({userId, fullName, dateOfBirth, gender, avatarPath, completedAt})` (UPSERT on `id`, client completion time) | `PUT /v1/me/profile/personal-info` (`upsertPersonalInfo`) | `{"full_name", "date_of_birth": "YYYY-MM-DD", "gender"?, "avatar_path"?}` (**no `personal_info_completed_at`**) | none | 200 Profile (row created when missing; `personal_info_completed_at` set by the server the first time) | `profiles:not_authenticated` (401), `profiles:invalid_full_name`, `profiles:invalid_date_of_birth`, `profiles:invalid_gender`, `profiles:invalid_avatar_path` (422), `validation:invalid_request` (422) |
| `updateEmergencyInfo({...})` (UPDATE, blank → null, client completion time) | `PUT /v1/me/profile/emergency-info` (`updateEmergencyInfo`) | the same 19 keys as today's payload (contact name, relationship, phone, email, blood type, allergies, medical conditions, preferred language, `location_sharing_enabled`, notes, the 9 flags) **without `emergency_info_completed_at`** | none | 200 Profile | `profiles:invalid_emergency_contact_full_name`, `profiles:invalid_relationship`, `profiles:invalid_phone`, `profiles:invalid_email`, `profiles:invalid_blood_type`, `profiles:emergency_notes_too_long` (422, in this order), `validation:invalid_request` (422), `profiles:profile_not_found` (404), `profiles:not_authenticated` (401) |
| `updatePreferences({...})` (UPDATE, client completion time) | `PUT /v1/me/profile/preferences` (`updatePreferences`) | `{"alert_push_enabled", "alert_email_enabled", "alert_sms_enabled", "location_sharing_enabled", "hide_profile_from_non_members", "app_language": "en", "timezone": "Africa/Banjul", "preferred_language"}` (**no `preferences_completed_at`**) | none | 200 Profile | `profiles:invalid_app_language`, `profiles:invalid_timezone`, `profiles:invalid_preferred_language` (422), `validation:invalid_request` (422), `profiles:profile_not_found` (404), `profiles:not_authenticated` (401) |
| `updateIncidentSharingFlags({userId, flags})` (UPDATE of the 9 flags) | `PATCH /v1/me/profile/sharing-flags` (`updateIncidentSharingFlags`) | `flags.toPayload()` unchanged (any subset of the 9 flags) | none | 200 Profile (only the sent flags change) | `validation:invalid_request` (422), `profiles:profile_not_found` (404), `profiles:not_authenticated` (401) |
| `updateLocationSharingEnabled({userId, enabled})` (UPDATE of one column) | `PATCH /v1/me/profile/location-sharing` (`updateLocationSharingEnabled`) | `{"enabled": true\|false}` (**key renamed** from the column name) | none | 200 Profile | `validation:invalid_request` (422), `profiles:profile_not_found` (404), `profiles:not_authenticated` (401) |
| `completeProfileSetup()` (RPC `complete_profile_setup`) | `POST /v1/me/profile/complete` (`completeProfileSetup`) | none | none | 200 `{circle_id, member_id, member_status, location_sharing_enabled, profile_setup_completed_at}` (same keys and values as the RPC) | `complete_profile_setup:not_authenticated` (401), `:profile_not_found` (404), `:personal_info_incomplete`, `:emergency_info_incomplete`, `:preferences_incomplete` (409). (`:circle_full` is in the spec but never returned, section 7.) |
| `uploadAvatar({userId, bytes, contentType})` (Storage `avatars.uploadBinary('{uid}/avatar.{ext}', upsert: true)`) | 1. `POST /v1/me/avatar/upload-url` (`createAvatarUploadUrl`) 2. `PUT <upload_url>` with the bytes 3. `PUT /v1/me/profile/avatar` (`setAvatar`) | 1. `{"content_type": "image/jpeg"\|"image/png"\|"image/webp", "content_length": <bytes>}` 2. the raw bytes with the answer's `headers` (`content-type`) 3. `{"object_path": <object_path of 1>}` | 2: no `Authorization` (the signed URL is the permission) | 1. 200 `{upload_url, method: "PUT", headers, object_path, expires_at}` (`cache-control: no-store`) 2. 200 from Storage 3. 200 Profile with the new `avatar_path` / `avatar_url` | 1. `profiles:invalid_content_type`, `profiles:file_too_large` (422), `profiles:avatar_storage_unavailable` (503), `rate_limit:exceeded` (429, 20 per hour per user). 3. `profiles:invalid_avatar_path` (422), `profiles:profile_not_found`, `profiles:avatar_not_found` (404), `profiles:avatar_storage_unavailable` (503) |
| `publicAvatarUrl(avatarPath)` (`getPublicUrl`, client side) | none: every Profile (and member list / preview) carries `avatar_url` | — | — | `{SUPABASE_URL}/storage/v1/object/public/avatars/{avatar_path}`, null without a photo | — |

Remove a photo: `PUT /v1/me/profile/avatar` `{"object_path": null}` (today: Personal Info with
`avatar_path: null`, which still works). The `memory_profile_repository.dart` test fake needs the
same changes.

Every error is the envelope `{"error": {"code": "<fn:code>", "message": "...", "details": {...}}}`.
`complete_profile_setup:*` codes are exactly the RPC's strings, so `mapCompleteProfileSetupError`
keeps working on `error.code` unchanged. The 422 codes carry `details.field` (the request field),
for the inline field errors of rule 57.

## 2. Shape changes the app must handle

| Change | What the API sends / expects | What the app should do |
| --- | --- | --- |
| **Completion timestamps are server-owned** (spec §4.2 note, D16) | Personal Info, Emergency Info and Preferences set `personal_info_completed_at` / `emergency_info_completed_at` / `preferences_completed_at` to the server's `now()` on the first save and never change them again; Complete sets `profile_setup_completed_at` once. Keys with these names in a request are ignored. | **Stop sending them** (drop `completedAt` from the three payload builders). Read them from the returned Profile instead of stamping the draft with `DateTime.now()`. Settings edits no longer re-stamp them (today every save overwrites them). |
| **Writes return the Profile** | P2-P6 and P9 answer 200 with the full Profile (as `GET /v1/me/profile`). | Replace the draft with the answer (no extra `fetchOwn` needed). |
| **No row → 404** | `GET` answers 404 `profiles:profile_not_found` (today `maybeSingle` → `null`); P3-P6 answer 404 when the row is missing (today an UPDATE of 0 rows succeeds silently). | Treat the 404 of `GET` as "no profile yet" (go to Personal Info). A 404 from P3-P6 means Personal Info was never saved: show the generic failure. |
| **Signed-URL avatar upload** (D17) | Three steps instead of one Storage call: upload URL (no profile needed, so onboarding can upload first), the bytes to `upload_url` (`PUT`, the answer's `headers`, before `expires_at`, once), then `PUT /v1/me/profile/avatar`. Every photo is a NEW object `{uid}/avatar-{uuid}.{ext}` (ext from the type, as today: jpg/png/webp), never an overwrite; the previous object is deleted by the API after step 3. Storage still enforces 5 MiB and the 3 types. | Keep the client-side type/size checks. Send `content_length` = the byte count. During onboarding: upload (steps 1-2), then Personal Info with `avatar_path` = the `object_path`, or step 3 after Personal Info. In Settings use step 3. The app needs no Storage access or credentials any more. |
| **Field validation on the server** (D16) | 422 `profiles:*` codes with `details.field` (section 1). Text is trimmed (as the app's `trim()`); blank optional text is stored as null; the contact phone must match `^\+[1-9][0-9]{7,14}$` (8-15 digits); the date of birth must not be after today (UTC = Banjul); emergency notes at most 500 characters. | Map the codes to the existing inline messages (`invalid_full_name` → full name, `invalid_date_of_birth` → date of birth, `invalid_emergency_contact_full_name` / `invalid_relationship` / `invalid_phone` / `invalid_email` → the contact card, `emergency_notes_too_long` → notes, the rest → generic). Tighten the app's phone rule from `\d{6,14}` to `\d{7,14}` after the first digit (a 7-digit number passes the app today and then fails Complete with `emergency_info_incomplete`). |
| **Personal Info: left-out keys** | `gender` / `avatar_path` left out keep the stored value; `null` clears. | Keep sending both as today (no change), or leave `avatar_path` out when using step 3. |
| **Location Sharing key** | `PATCH /v1/me/profile/location-sharing` takes `{"enabled": ...}`. Turning it on creates nothing: call `POST /v1/me/profile/complete` next (rule 6a), as `enableLocationSharingAndComplete` already does. | Rename the key. |
| **Validation 422** (no RPC equivalent) | `validation:invalid_request` + `details.field` for a body that is not a JSON object or a value of the wrong JSON type (e.g. a flag that is not a boolean). | A client bug: show the generic failure. |
| **429 / 500 / 503** | `rate_limit:exceeded` (default 300 / 60 s per user; the upload URL 20 / hour); `internal:error` (500); `profiles:avatar_storage_unavailable` (503) when Storage is down. | Same as a network error today; for the photo, "Couldn't upload the photo. Try again." |
| **Medical info as lists (SCRUM-21, D51)** | `POST /v1/me/profile/allergies {text}`, `PATCH /v1/me/profile/allergies/{item_id} {text}`, `DELETE /v1/me/profile/allergies/{item_id}`, the same under `/medical-conditions`; each answers the Profile. The Profile has `allergy_items` / `medical_condition_items` (`[{id, text, updated_at}]`, oldest first) and `medical_info_updated_at`. Errors: 422 `profiles:invalid_medical_item` (blank or more than 100 characters), 409 `profiles:duplicate_medical_item` / `profiles:medical_item_limit_reached` (20), 404 `profiles:medical_item_not_found`. `PUT .../emergency-info` ignores `allergies` / `medical_conditions`. | Show the lists from the item keys; one call per add / edit / delete; "Last updated" from `medical_info_updated_at`. The old `allergies` / `medical_conditions` strings are the items joined with ", " (read-only). |
| **Generated client** | `clients/dart` models: `Profile`, `PersonalInfoRequest`, `EmergencyInfoRequest`, `PreferencesRequest`, `SharingFlagsRequest`, `LocationSharingRequest`, `ProfileSetupResult`, `AvatarUploadUrlRequest`, `AvatarUploadUrl`, `SetAvatarRequest` (as in `openapi.json`). | Map them to the app's `ProfileRow` / `CompleteProfileSetupResult`; the JSON keys are the ones the app parses today (`avatar_url` is new). |

## 3. Client timeouts (spec §7.8) and measured latency

The app caps the profile fetch at 15 s (`kProfileFetchTimeout`, error state with retry). The writes,
Complete and the avatar upload have no client cap today. Measured on the built app (section 4):

| Call | Client cap | Measured p50 / p95 / p99 (ms) |
| --- | --- | --- |
| `fetchOwnProfile` (`GET /v1/me/profile`, also the steady reload) | 15 s | 17.8 / 181.1 / 216.4 |
| Personal Info / Emergency Info / Preferences | none | 127.9 / 184.5 / 191.8; 187.9 / 201.2 / 201.8; 149.5 / 165.0 / 167.5 |
| sharing flags / location sharing | none | 68.3 / 177.7 / 186.6; 172.7 / 184.0 / 184.5 |
| Complete (incl. the deferred second call) | none | 186.1 / 241.7 / 273.5 |
| upload URL / bytes to the signed URL (Storage fake) / set avatar | none | 59.5 / 125.7 / 128.7; 24.3 / 86.4 / 94.4; 151.6 / 281.1 / 296.1 |

Sequential reads in the integration test (`profiles-read.int-spec.ts`): p99 under 500 ms (AC3 of
API-100-34). Every profile call answers far inside the 15 s cap; the tails are the synchronized
burst of the scenario (60 users onboarding in the same second on 10 pooled connections). The photo
bytes go to Supabase Storage in production, so the upload itself depends on the phone's network,
not on the API. Suggestion for the switch epic: give the profile writes and Complete the same 15 s
cap as the fetch, and the photo upload 30 s.

## 4. Load check

`npm run build && npm run load:profiles` (about 1.5 minutes; Docker must be running). It uses the
shared load harness (`test/load/load-harness.ts`): its own throwaway Postgres 17.11 and Redis
containers (random ports and password; the local compose database is not touched, the containers are
removed afterwards), `node dist/main.js` on a spare port with a throwaway JWT secret, the **default**
rate limits and `AVATAR_STORAGE=memory` (the in-process Storage fake: no key, nothing leaves the
machine). 60 new users (an Auth account, no profile), all at once: photo upload URL and bytes,
Personal Info with the photo, Profile, Emergency Info (every other user with Location Sharing off),
Preferences, Complete, Profile; the users with sharing off turn it on and complete again (deferred
creation); 60 s of Profile reloads every 5 s and a share-flag change every 15 s; then a Personal Info
edit and a new photo (upload URL, bytes, set avatar). It fails on any unexpected status, any app
error log line, wrong rows, or a route p99 not under 15 s.

Result of the final run on 2026-11-20 (Windows laptop, Docker Desktop, built app, default pool of 10
connections, default rate limits): **1,782 requests in 62.0 s, 0 errors, 0 app error log lines, row
check ok** (every profile with the four completion timestamps, the edited name and a new
`avatar-{uuid}.jpg` path; one circle, one active owner row with `activated_at` and one pending 7-day
contact invite per user).

| Route | Requests | Errors | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| POST /v1/me/avatar/upload-url | 120 | 0 | 59.5 | 125.7 | 128.7 | 129.4 |
| PUT <signed upload URL> (Storage fake) | 120 | 0 | 24.3 | 86.4 | 94.4 | 95.5 |
| PUT /v1/me/profile/personal-info | 120 | 0 | 127.9 | 184.5 | 191.8 | 195.2 |
| GET /v1/me/profile | 860 | 0 | 17.8 | 181.1 | 216.4 | 220.7 |
| PUT /v1/me/profile/emergency-info | 60 | 0 | 187.9 | 201.2 | 201.8 | 201.8 |
| PUT /v1/me/profile/preferences | 60 | 0 | 149.5 | 165.0 | 167.5 | 167.5 |
| POST /v1/me/profile/complete | 90 | 0 | 186.1 | 241.7 | 273.5 | 273.5 |
| PATCH /v1/me/profile/location-sharing | 30 | 0 | 172.7 | 184.0 | 184.5 | 184.5 |
| PATCH /v1/me/profile/sharing-flags | 262 | 0 | 68.3 | 177.7 | 186.6 | 187.7 |
| PUT /v1/me/profile/avatar | 60 | 0 | 151.6 | 281.1 | 296.1 | 296.1 |

## 5. Auth notes

- Until Phase 6 the API accepts the **Supabase access token** the app already has (same header, same
  refresh by the Supabase SDK). Own tokens and the one-time session exchange arrive with Phase 6
  (D8); nothing in this phase depends on them.
- Every route answers `<prefix>:not_authenticated` (401) for a missing, invalid or expired token:
  `profiles:not_authenticated`, or `complete_profile_setup:not_authenticated` for Complete. A valid
  token whose user no longer exists also gets `profiles:not_authenticated` on Personal Info.
- No route can read or write another user's profile (there is no id to name one;
  `profile-exposure.int-spec.ts` calls every route of the API as other users with the target's ids
  and finds none of its profile fields, only its name and photo URL where Phases 1-2 already show
  them).
- The signed upload URL is the only credential the app ever gets for Storage: single use, one
  object path in the user's own folder, 2 hours. The Storage service key stays on the server.

## 6. Checks before the switch

- [ ] **Storage key in the API's secret store**: add `SUPABASE_STORAGE_SERVICE_KEY` (the
      `atlas_staging` project's secret / service-role key) to the API host's secrets; it is required
      when `NODE_ENV=production` (the API refuses to start without it) and is never logged. Keep
      `AVATAR_STORAGE` unset or `supabase` (`memory` is refused in production).
- [ ] **Bucket `avatars` on `atlas_staging`** (read-only check): public, `file_size_limit`
      5,242,880, `allowed_mime_types` `image/jpeg, image/png, image/webp` (spec §4.11). Then one
      manual upload through the API on staging (optional step of the Phase 3 guide, needs the real
      key; not run by the agent).
- [ ] **Hosted session settings and collation** (read-only, as in `docs/phase2_handoff.md` §6):
      `show timezone;` → `UTC`; `select datlocprovider, datcollate from pg_database where datname =
      current_database();`.
- [ ] **API config of the hosted project**: `SUPABASE_URL` (avatar URLs are built from it, as in
      Phase 2), `AVATARS_BUCKET=avatars`, `INVITE_URL_BASE` (default), `TRUST_PROXY` (the proxy in
      front of the API), the rate limits (`RATE_LIMIT_AVATAR_UPLOAD_*` default 20 / hour).
- [ ] **The SQL functions and direct table access stay deployed** until Phase 7; do not drop or
      change them (old app versions still write `profiles` directly and stamp the completion
      timestamps themselves).
- [ ] **D18 applies only to the API.** While old app versions call `complete_profile_setup` through
      the SQL function, it can still deadlock with an owner write that takes the circle and then the
      owner row (rare; the app then shows "Could not complete setup. Try again."). It disappears once
      the app completes through the API.
- [ ] Drop the client-side completion timestamps, the direct Storage upload and `getPublicUrl`
      (section 2).
- [ ] API deployed with production config, `/readyz` green; Dawit's manual QA of onboarding and
      Settings (the Phase 3 Git Bash guide) passes.

## 7. Known differences from today (each decided)

| Difference | Decision |
| --- | --- |
| Completion timestamps are set by the server once and never reset; requests cannot write them (today the app writes its own clock on every save). | Spec §4.2 note, API-100-35 AC6, **D16**. |
| Field validation on the server with new `profiles:*` codes (today only the table's check constraints, which answered PostgREST 400s with a constraint message). | API-100-35, **D16**. |
| The contact phone must have 8-15 digits (`complete_profile_setup`'s rule); the app accepts 7-15 today, and such a number then fails Complete. | **D16** (stricter: a saved number can always complete setup). |
| `GET` without a row is 404 (today `null`); P3-P6 on a missing row are 404 (today silent no-ops). | API-100-34/35 AC7. |
| Writes answer the full Profile (today no body). | API-100-35 AC7. |
| Photos: signed upload URL, a new object per photo, the previous one deleted after it is replaced (today an upsert of `{uid}/avatar.{ext}`; a change of type left the old object behind). Existing paths stay valid. | API-100-37, **D17**. |
| `avatar_url` comes from `SUPABASE_URL` + bucket (today the app's `getPublicUrl`, and the SQL's `_avatars_public_url` from the request host): the same URL on the hosted project. | Spec §11.3 P8 note, API-100-25/37. |
| Complete locks the circle before the owner row (the SQL locks the owner row first and can deadlock with a resend naming the owner row); same answers and rows. | **D18** (`profile-setup-races.int-spec.ts` shows both). |
| A circle created concurrently by another writer (the app's direct RLS insert) is locked instead of failing Complete with a 500. | **D18**. |
| `complete_profile_setup:circle_full` is listed in the spec but never returned (the function catches it since 2026-11-17, and so does the API). | Proven in `phase3-error-codes.int-spec.ts`. |
| The API writes an `audit_log` row `profile.setup_completed` on the first completion (ids, `deferred`, `circle_created`, the contact row's status; never a name or phone); the SQL writes none. Not visible to the app. | API-100-14, **D18**. |
