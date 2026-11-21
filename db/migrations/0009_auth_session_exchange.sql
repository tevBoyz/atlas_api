-- API-100-59 (D8): the one-time session exchange. A session opened by `POST /v1/auth/exchange`
-- records the Supabase Auth session it replaced (the `session_id` claim of the Supabase access
-- token); the unique index makes the exchange once per Supabase session, also under concurrency.
--
-- Additive only (AGENTS.md rule 4): one nullable column and one partial unique index on a table of
-- migration 0008. Re-runnable on a fresh database after the baseline.

alter table public.device_sessions
  add column if not exists exchanged_supabase_session_id uuid null;

create unique index if not exists device_sessions_exchanged_supabase_session_key
  on public.device_sessions (exchanged_supabase_session_id)
  where exchanged_supabase_session_id is not null;
