# API-owned migrations (`npm run db:migrate`)

Plain SQL migrations owned by the Atlas API, applied **after** the Supabase baseline in
`db/baseline/`.

| File                        | Story      | What                                          |
| --------------------------- | ---------- | --------------------------------------------- |
| `0001_idempotency_keys.sql` | API-100-10 | `idempotency_keys` table + `expires_at` index |
| `0002_lock_down_api_schema_migrations.sql` | API-100-03 follow-up | revoke `anon`/`authenticated` + RLS on `api_schema_migrations` |
| `0003_audit_log.sql` | API-100-14 | append-only `audit_log` (triggers refuse UPDATE, DELETE, TRUNCATE) |
| `0004_client_incidents_backend_switch.sql` | Phase 1 rollback switch | data only: `app_config` row `client_incidents_backend` = `"supabase"` (see below) |
| `0005_user_devices.sql` | API-100-44 | `user_devices`: app installations and push tokens (token unique across devices) |
| `0006_notification_outbox.sql` | API-100-45 | `notification_outbox`: transactional outbox published to BullMQ by the relay |
| `0007_notification_deliveries.sql` | API-100-47 | `notification_deliveries`: one row per recipient x channel x device with its outcome |
| `0008_auth_schema.sql` | API-100-50 | own auth: `users`, `user_credentials`, `user_identities`, `device_sessions`, `refresh_tokens`, `auth_tokens` (+ `citext` in `extensions`) |
| `0009_auth_session_exchange.sql` | API-100-59 | `device_sessions.exchanged_supabase_session_id` (unique): the one-time Supabase session exchange (D8) |
| `0010_users_foreign_keys.sql` | Phase 7 (D36, D37) | the `profiles` / `safety_circle_members` / `user_devices` foreign keys repointed at `users`; compatibility trigger |
| `0011_session_revoke_password_change.sql` | Phase 7 (D38) | `device_sessions.revoke_reason` allows `password_change` |
| `0012_retire_supabase_app_paths.sql` | API-100-62 (D42) | **non-additive (approved):** `anon` / `authenticated` / PUBLIC table and function grants revoked, `incidents` / `incident_events` out of `supabase_realtime`, `avatars` write policies dropped; recorded in `api_retired_supabase_access`; rollback `db/rollback/0012_down.sql` |
| `0013_membership_end_status.sql` | SCRUM-30/31 (D44) | `safety_circle_members.status` allows `removed` / `left`; nullable `ended_at` (set exactly for those two, check `safety_circle_members_ended_shape`): remove / leave keep the row as history |
| `0014_medical_info_items.sql` | SCRUM-21 (D51-D53) | `profile_allergies` / `profile_medical_conditions` (one row per item, owner-only; back-filled: each existing non-blank text becomes one item); `profiles.medical_info_updated_at`; `incidents.live_share_payload` + `live_share_updated_at` (the live shared info of an active incident; `share_payload` stays the activation snapshot) |
| `0015_incident_response_status.sql` | SCRUM-49/50/51/55 (D56) | `incident_deliveries.response_status` (null / `responding` / `unable`, check `incident_deliveries_response_status_allowed`) + `response_at` (set exactly with the status, check `incident_deliveries_response_shape`); existing rows unchanged |
| `0016_share_phone_emergency_numbers.sql` | SCRUM-52/54 (D59, D60) | `profiles.share_phone` (not null, default **true**: on for new and existing profiles; adds `resident_phone`, the confirmed account phone, to the share payload); data: `app_config` row `emergency_numbers` (by country; seeded GM: Ambulance 116, Police 117, Fire and Rescue 119; `on conflict do nothing`) |
| `0017_incident_closed_state.sql` | SCRUM-63 (D61, D62) | `incidents.status` allows `closed`; nullable `closed_at` (check `incidents_closed_shape`: set exactly for `closed`, whose `resolved_reason` is `safe`/`ended`); `incidents_resolved_shape_check` / `incidents_location_sharing_ended_shape` widened to `resolved`/`closed`; index `incidents_resolved_at_resolved_idx`; data: `app_config` `incident_close_after_minutes` = 30, `incident_auto_close_after_hours` = 24 (`on conflict do nothing`). Written only by the API close sweeper |
| `0018_circle_test_alerts.sql` | SCRUM-35 (D66-D68) | `circle_test_alerts` (one row per test alert: circle, owner, time, `recipient_count` > 0) and `circle_test_alert_receipts` (its recipients, the active members at send time, with `seen_at`), both locked down; `notification_deliveries.test_alert_id` (nullable, FK, cascades; check `notification_deliveries_single_subject`: never both an incident and a test) + index; data: `app_config` `circle_test_alert_min_interval_minutes` = 5, `circle_test_alert_daily_max` = 10 (`on conflict do nothing`). A test alert never touches incidents |

- File name: `<number>_<snake_case_description>.sql`, e.g. `0001_audit_log.sql`. Applied in number
  order; the id recorded is the file name without `.sql`.
- Each file runs in its own transaction and is recorded in
  `public.api_schema_migrations (id text primary key, applied_at timestamptz)`.
- **Additive and backward compatible only** (new tables, new nullable columns, new indexes): the
  mobile app and the Supabase SQL functions share this database until cutover (AGENTS.md rule 4).
  The one approved exception is `0012` (API-100-62, D42), which ships with a tested rollback script
  in `db/rollback/`.
- Never edit a migration that has been applied anywhere; add a new one.
- Re-runnable on a fresh database after the baseline (epic §5, definition of done 5).
- Do not write `create index concurrently` (it cannot run inside a transaction).
- New tables in `public` are reachable by the `anon` / `authenticated` roles through Supabase's
  default privileges (PostgREST). Revoke those grants and enable RLS unless the app must read the
  table directly (see `0001`).
- Readiness (API-100-07): `GET /readyz` reports `migrations` until every file here is recorded in
  `api_schema_migrations`. `npm run build` records the ids in `dist/migrations-manifest.json` (the
  Docker image ships that list, not this folder), so rebuild after adding a migration.

## The incidents backend switch (`0004`)

`public.app_config` key `client_incidents_backend` chooses the backend of the mobile app's incident
area (docs/phase1_handoff.md section 5). The row exists from `0004` with the value `"supabase"`
(JSON string). Values: `"supabase"` (the SQL RPCs) or `"api"` (this API). Signed-in users can read
it through the existing `app_config` SELECT policy; they cannot write it. Flip it as the service
role / `postgres`:

```sql
update public.app_config set value = '"api"'::jsonb where key = 'client_incidents_backend';
update public.app_config set value = '"supabase"'::jsonb where key = 'client_incidents_backend'; -- rollback
```

Re-running `0004` never resets a value ops already set (`on conflict do nothing`).
