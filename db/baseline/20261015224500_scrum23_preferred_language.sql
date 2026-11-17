-- SCRUM-23: Preferred Language (responder communication preference)
-- Additive column on public.profiles. Distinct from SCRUM-18 app_language (UI).
-- Does not alter SCRUM-17/18 columns, RLS, or create incident tables.

-- ---------------------------------------------------------------------------
-- preferred_language
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists preferred_language text not null default 'en';

comment on column public.profiles.preferred_language is
  'SCRUM-23: Language responders should use with this resident. Codes: en|wo|mnk|ff. Not app UI language (app_language).';

alter table public.profiles
  drop constraint if exists profiles_preferred_language_allowed;

alter table public.profiles
  add constraint profiles_preferred_language_allowed
  check (preferred_language in ('en', 'wo', 'mnk', 'ff'));

-- RLS policies from SCRUM-17 (select/insert/update own) already cover this column.
-- No new policies or grants required.
-- Incident tables do not exist yet; responders will read this from the resident profile later.
