-- Security follow-up to API-100-03 / API-100-10: lock down the migration tracking table.
-- `public.api_schema_migrations` is created by the runner (`npm run db:migrate`) and, like every
-- table in `public`, was reachable by the Supabase `anon` / `authenticated` API roles through
-- default privileges (PostgREST could read or change which migrations are recorded). Same pattern
-- as `0001_idempotency_keys.sql`: those roles get no privileges and RLS is enabled with no policy
-- (deny). The API and the runner connect as the table owner, which is unaffected.
--
-- Additive only (AGENTS.md rule 4). Idempotent: revoking absent grants and enabling RLS twice are
-- no-ops. The runner itself now applies the same lock-down when it creates the table
-- (src/db/tooling/migrate.ts), so this migration fixes databases created before that change.

alter table public.api_schema_migrations enable row level security;

revoke all on table public.api_schema_migrations from public;
revoke all on table public.api_schema_migrations from anon;
revoke all on table public.api_schema_migrations from authenticated;
