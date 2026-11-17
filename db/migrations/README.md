# API-owned migrations (`npm run db:migrate`)

Plain SQL migrations owned by the Atlas API, applied **after** the Supabase baseline in
`db/baseline/`. None exist yet (API-100-03 ships the runner only).

- File name: `<number>_<snake_case_description>.sql`, e.g. `0001_audit_log.sql`. Applied in number
  order; the id recorded is the file name without `.sql`.
- Each file runs in its own transaction and is recorded in
  `public.api_schema_migrations (id text primary key, applied_at timestamptz)`.
- **Additive and backward compatible only** (new tables, new nullable columns, new indexes): the
  mobile app and the Supabase SQL functions share this database until cutover (AGENTS.md rule 4).
- Never edit a migration that has been applied anywhere; add a new one.
- Re-runnable on a fresh database after the baseline (epic §5, definition of done 5).
- Do not write `create index concurrently` (it cannot run inside a transaction).
