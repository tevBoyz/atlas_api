-- API-100-14: append-only audit log of security-relevant actions (spec §11.7, SCRUM-74 foundation).
-- One row per action, written by AuditService inside the caller's transaction. `occurred_at` is the
-- transaction time, like every other server timestamp. `actor_user_id` and `target_id` carry no
-- foreign key on purpose: an audit row must outlive the user or row it talks about.
--
-- Append-only. Decision D10 (epic §18) has the API connect as the existing role, which OWNS this
-- table, and a REVOKE does not bind a table's owner. So statement-level triggers refuse UPDATE,
-- DELETE and TRUNCATE for every role, the owner included (statement-level so that a statement
-- matching no rows is refused too). Removing the triggers takes a deliberate schema change.
--
-- Additive only (AGENTS.md rule 4): one new table, its function, triggers and indexes. Re-runnable
-- on a fresh database after the baseline.
--
-- Supabase exposes tables in `public` to the `anon` / `authenticated` API roles through default
-- privileges (PostgREST). Those roles get no privileges and RLS is enabled with no policy (deny),
-- the same pattern as 0001 and 0002.

create table if not exists public.audit_log (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid null,
  actor_session_id uuid null,
  action text not null,
  target_type text null,
  target_id uuid null,
  ip inet null,
  request_id text null,
  detail jsonb not null default '{}'::jsonb,
  constraint audit_log_action_check check (length(btrim(action)) > 0),
  constraint audit_log_detail_check check (jsonb_typeof(detail) = 'object')
);

comment on table public.audit_log is
  'API-100-14: append-only audit log. Written only by the API (AuditService), inside the transaction of the action it records. UPDATE, DELETE and TRUNCATE are refused by triggers. detail never holds medical or share fields, tokens, full phone numbers or coordinates.';

-- Support and compliance questions: by time, by who acted, by what was acted on.
create index if not exists audit_log_occurred_at_idx
  on public.audit_log (occurred_at);
create index if not exists audit_log_actor_idx
  on public.audit_log (actor_user_id, occurred_at)
  where actor_user_id is not null;
create index if not exists audit_log_target_idx
  on public.audit_log (target_type, target_id, occurred_at)
  where target_id is not null;

create or replace function public.audit_log_refuse_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only: % is not allowed', tg_op
    using errcode = 'P0001';
end;
$$;

revoke all on function public.audit_log_refuse_change() from public;
revoke all on function public.audit_log_refuse_change() from anon;
revoke all on function public.audit_log_refuse_change() from authenticated;

create or replace trigger audit_log_no_update_or_delete
  before update or delete on public.audit_log
  for each statement
  execute function public.audit_log_refuse_change();

create or replace trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement
  execute function public.audit_log_refuse_change();

alter table public.audit_log enable row level security;

revoke all on table public.audit_log from public;
revoke all on table public.audit_log from anon;
revoke all on table public.audit_log from authenticated;
revoke all on sequence public.audit_log_id_seq from public;
revoke all on sequence public.audit_log_id_seq from anon;
revoke all on sequence public.audit_log_id_seq from authenticated;
