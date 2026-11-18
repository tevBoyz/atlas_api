# API-owned migrations (`npm run db:migrate`)

Plain SQL migrations owned by the Atlas API, applied **after** the Supabase baseline in
`db/baseline/`.

| File                        | Story      | What                                          |
| --------------------------- | ---------- | --------------------------------------------- |
| `0001_idempotency_keys.sql` | API-100-10 | `idempotency_keys` table + `expires_at` index |
| `0002_lock_down_api_schema_migrations.sql` | API-100-03 follow-up | revoke `anon`/`authenticated` + RLS on `api_schema_migrations` |
| `0003_audit_log.sql` | API-100-14 | append-only `audit_log` (triggers refuse UPDATE, DELETE, TRUNCATE) |

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
