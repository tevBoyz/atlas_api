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

- File name: `<number>_<snake_case_description>.sql`, e.g. `0001_audit_log.sql`. Applied in number
  order; the id recorded is the file name without `.sql`.
- Each file runs in its own transaction and is recorded in
  `public.api_schema_migrations (id text primary key, applied_at timestamptz)`.
- **Additive and backward compatible only** (new tables, new nullable columns, new indexes): the
  mobile app and the Supabase SQL functions share this database until cutover (AGENTS.md rule 4).
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
