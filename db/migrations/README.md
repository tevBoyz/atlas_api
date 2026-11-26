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
| `0019_user_devices_push_token_invalid_hash.sql` | Gap 49 (D69) | `user_devices.push_token_invalid_hash` (text, nullable): SHA-256 (hex) of the last token the provider answered `unregistered` for (never the token); U1 refuses that token (`push_token_status` `invalid`), any other token clears it. The table keeps its 0005 lockdown |
| `0020_incident_events_status_update.sql` | SCRUM-44/59 (D70) | `incident_events_type_allowed` widened: `status_update` (the resident's status update, detail `{preset}` or `{text}`; may repeat, so not in the once-per-incident index). Written only by the API |
| `0021_incident_events_responder.sql` | SCRUM-60/61 (D71) | `incident_events_type_allowed` widened: `responder_acknowledged` (a member's first acknowledge, detail `{}`) and `responder_status` (a member's response status change, detail `{status}`); both repeat per incident, so not in the once-per-incident index. Written only by the API |
| `0022_notification_deliveries_final_at.sql` | SCRUM-65/66/67/71 (D73) | `notification_deliveries.final_at` (timestamptz, nullable): when the row became final (sent/delivered = `sent_at`; failed/skipped = then); existing final rows back-filled `coalesce(sent_at, updated_at)`; check `notification_deliveries_final_at_shape` (null exactly while `queued`); BEFORE trigger `notification_deliveries_fill_final_at` fills it for a writer that does not set it (older build). `incident_deliveries.delivery_failed_notified_at` (timestamptz, nullable): the resident was told this member did not receive the alert (once per member per incident). Written only by the API worker |
| `0023_incident_location_unavailable_since.sql` | SCRUM-68 (D74) | `incidents.location_unavailable_since` (timestamptz, nullable): since when live location is reported unavailable; check `incidents_location_unavailable_since_shape` (set only with a stored `location_source`). An `unavailable` report keeps the last known fix and sets it; the next fix clears it |
| `0024_support_incident_audit_view.sql` | SCRUM-74 (D75) | read-only view `support_incident_audit` (security_invoker): every `audit_log` row with `target_type = 'incident'` in time order, with the incident's resident id and name, circle id, emergency type and status; ids and names only (no coordinates, notes, share payloads, phone numbers, tokens or client IP); no privilege for `anon` / `authenticated`. Support reads it in the SQL editor (runbook §2.8) |
| `0025_drop_legacy_sql.sql` | Stage 1 (D76) | **non-additive (approved):** drops the 18 RLS policies of the old app's direct access (RLS stays enabled), the 69 Supabase-era `public` SQL functions (the 14 trigger / table-plumbing functions stay) and the 0004 `app_config` row `client_incidents_backend`; self-check at the end; rollback `db/rollback/0025_down.sql` (run it before `0012_down.sql`) |

- File name: `<number>_<snake_case_description>.sql`, e.g. `0001_audit_log.sql`. Applied in number
  order; the id recorded is the file name without `.sql`.
- Each file runs in its own transaction and is recorded in
  `public.api_schema_migrations (id text primary key, applied_at timestamptz)`.
- **Additive and backward compatible** (new tables, new nullable columns, new indexes), so a deploy
  never breaks a running build (AGENTS.md rule 4). The approved exceptions are `0012` (API-100-62,
  D42) and `0025` (D76, the old SQL backend removed), each with a tested rollback script in
  `db/rollback/`. Migrations no longer need to keep the old SQL functions working (they are gone).
- Never edit a migration that has been applied anywhere; add a new one.
- Re-runnable on a fresh database after the baseline (epic §5, definition of done 5).
- Do not write `create index concurrently` (it cannot run inside a transaction).
- New tables in `public` are reachable by the `anon` / `authenticated` roles through Supabase's
  default privileges (PostgREST). Revoke those grants and enable RLS unless the app must read the
  table directly (see `0001`).
- Readiness (API-100-07): `GET /readyz` reports `migrations` until every file here is recorded in
  `api_schema_migrations`. `npm run build` records the ids in `dist/migrations-manifest.json` (the
  Docker image ships that list, not this folder), so rebuild after adding a migration.

## The incidents backend switch (`0004`, removed by `0025`)

`0004` seeded the `app_config` row `client_incidents_backend` (`"supabase"` / `"api"`), the Phase 1
per-area rollback switch (docs/phase1_handoff.md section 5). D13 made it unused (one switch at the
end) and `0025` (D76) deletes the row; `db/rollback/0025_down.sql` restores it with `"supabase"`.
