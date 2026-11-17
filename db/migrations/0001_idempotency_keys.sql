-- API-100-10: Idempotency-Key storage (spec §11.2, rule 55; epic API-100-10 AC1).
-- One row per (user, key): the request fingerprint and, once the handler finished with a 2xx or
-- 4xx, the stored response replayed for retries. Rows expire 24 h after their claim; the API
-- purges an expired key when it is presented again and sweeps expired rows opportunistically.
-- Owned and written only by the API (no SQL function, trigger or app path touches it).
--
-- Additive only (AGENTS.md rule 4): a new table and its index. Re-runnable on a fresh database
-- after the baseline.
--
-- Supabase exposes tables in `public` to the `anon` / `authenticated` API roles through default
-- privileges (PostgREST). Stored response bodies can contain incident data, so those roles get no
-- privileges and RLS is enabled with no policy (deny). The API connects as the table owner.

create table if not exists public.idempotency_keys (
  user_id uuid not null,
  key text not null,
  method text not null,
  path text not null,
  request_hash text not null,
  status text not null,
  response_status integer null,
  response_body jsonb null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint idempotency_keys_pkey primary key (user_id, key),
  constraint idempotency_keys_status_check check (status in ('in_progress', 'completed'))
);

comment on table public.idempotency_keys is
  'API-100-10: Idempotency-Key claims and stored responses (per user). created_at = claim time (reset when an abandoned in_progress claim older than 60 s is taken over). Expired (expires_at <= now()) rows are unknown keys. API-only.';

-- Cleanup of expired keys (`where expires_at <= now()`).
create index if not exists idempotency_keys_expires_at_idx
  on public.idempotency_keys (expires_at);

alter table public.idempotency_keys enable row level security;

revoke all on table public.idempotency_keys from public;
revoke all on table public.idempotency_keys from anon;
revoke all on table public.idempotency_keys from authenticated;
