-- SCRUM-22: Emergency Notes
-- Additive columns on public.profiles (lean V1 — no new table, no Edge Functions).
-- Saved on the same Emergency Info Continue as SCRUM-79.
-- Does not alter SCRUM-17/18/23/79 columns, RLS, or completion (emergency_info_completed_at).

-- ---------------------------------------------------------------------------
-- Optional notes + shareable flag (default OFF)
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists emergency_notes text null,
  add column if not exists emergency_notes_shareable boolean not null default false;

comment on column public.profiles.emergency_notes is
  'SCRUM-22: Optional free-text emergency notes. Max 500 characters. Null if unused. Saved on Emergency Info Continue with SCRUM-79 fields.';
comment on column public.profiles.emergency_notes_shareable is
  'SCRUM-22: Whether emergency_notes may be shared later. Default false — no hidden opt-in. Do not set preferences_completed_at from Emergency Info Continue.';

alter table public.profiles
  drop constraint if exists profiles_emergency_notes_length;

alter table public.profiles
  add constraint profiles_emergency_notes_length
  check (
    emergency_notes is null
    or char_length(emergency_notes) <= 500
  );

-- RLS policies from SCRUM-17 (select/insert/update own) already cover these columns.
-- No new policies or grants required.
-- Completing Emergency Info must not set preferences_completed_at (SCRUM-18).
-- Incident / responder display is a later handoff; no cross-user SELECT here.
