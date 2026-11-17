-- SCRUM-18: Profile Preferences Setup
-- Additive columns on public.profiles (lean V1 — no separate user_preferences table).
-- Does not alter SCRUM-17 personal-info columns, RLS, or avatars storage.

-- ---------------------------------------------------------------------------
-- Preference columns
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists alert_push_enabled boolean not null default true,
  add column if not exists alert_email_enabled boolean not null default true,
  add column if not exists alert_sms_enabled boolean not null default true,
  add column if not exists location_sharing_enabled boolean not null default true,
  add column if not exists hide_profile_from_non_members boolean not null default false,
  add column if not exists app_language text not null default 'en',
  add column if not exists timezone text not null default 'Africa/Banjul',
  add column if not exists preferences_completed_at timestamptz null;

comment on column public.profiles.alert_push_enabled is
  'SCRUM-18: Push alert preference. Default true (wireframe ON).';
comment on column public.profiles.alert_email_enabled is
  'SCRUM-18: Email alert preference. Default true (wireframe ON).';
comment on column public.profiles.alert_sms_enabled is
  'SCRUM-18: SMS alert preference. Default true (wireframe ON).';
comment on column public.profiles.location_sharing_enabled is
  'SCRUM-18: Atlas Location Sharing (app setting). Distinct from OS location permission (SCRUM-19). Required for Safety Circle when OS permission is also granted.';
comment on column public.profiles.hide_profile_from_non_members is
  'SCRUM-18: When true, hide profile from people outside the user Safety Circle. Default false.';
comment on column public.profiles.app_language is
  'SCRUM-18: App language code. V1 allows en only.';
comment on column public.profiles.timezone is
  'SCRUM-18: IANA timezone. V1 default Africa/Banjul (GMT+00:00 Banjul).';
comment on column public.profiles.preferences_completed_at is
  'SCRUM-18: Set when Preferences Continue succeeds. Null means Preferences step still needed.';

-- V1 language lock
alter table public.profiles
  drop constraint if exists profiles_app_language_allowed;

alter table public.profiles
  add constraint profiles_app_language_allowed
  check (app_language = 'en');

-- V1 timezone lock (Banjul / GMT+00:00)
alter table public.profiles
  drop constraint if exists profiles_timezone_allowed;

alter table public.profiles
  add constraint profiles_timezone_allowed
  check (timezone = 'Africa/Banjul');

create index if not exists profiles_preferences_completed_at_idx
  on public.profiles (preferences_completed_at);

-- RLS policies from SCRUM-17 (select/insert/update own) already cover these columns.
-- No new policies or grants required.
