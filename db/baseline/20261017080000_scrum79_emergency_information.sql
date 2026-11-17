-- SCRUM-79: Emergency Information Setup
-- Additive columns on public.profiles (lean V1 — one contact, no new table).
-- Does not alter SCRUM-17/18/23 columns, RLS, or profiles_preferred_language_allowed.

-- ---------------------------------------------------------------------------
-- Emergency contact + optional medical + emergency language
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists emergency_contact_full_name text null,
  add column if not exists emergency_contact_relationship text null,
  add column if not exists emergency_contact_phone text null,
  add column if not exists emergency_contact_email text null,
  add column if not exists blood_type text null,
  add column if not exists allergies text null,
  add column if not exists medical_conditions text null,
  add column if not exists emergency_preferred_language text null,
  add column if not exists emergency_info_completed_at timestamptz null;

comment on column public.profiles.emergency_contact_full_name is
  'SCRUM-79: Single emergency contact display name. Required on Continue (trim nonempty). Null until step completed.';
comment on column public.profiles.emergency_contact_relationship is
  'SCRUM-79: spouse|partner|parent|child|sibling|friend|other. Required on Continue. Null allowed until then.';
comment on column public.profiles.emergency_contact_phone is
  'SCRUM-79: Emergency contact phone in E.164 (including +220). Required on Continue.';
comment on column public.profiles.emergency_contact_email is
  'SCRUM-79: Optional emergency contact email.';
comment on column public.profiles.blood_type is
  'SCRUM-79: Optional. A+|A-|B+|B-|AB+|AB-|O+|O-|Unknown, or null.';
comment on column public.profiles.allergies is
  'SCRUM-79: Optional free-text allergies.';
comment on column public.profiles.medical_conditions is
  'SCRUM-79: Optional free-text medical conditions.';
comment on column public.profiles.emergency_preferred_language is
  'SCRUM-79: Optional free-text emergency language. Not preferred_language (SCRUM-23 enum) and not app_language (SCRUM-18).';
comment on column public.profiles.emergency_info_completed_at is
  'SCRUM-79: Set when Emergency Info Continue succeeds. Null means Emergency Info step still needed. Do not set preferences_completed_at from this step.';

alter table public.profiles
  drop constraint if exists profiles_emergency_contact_relationship_allowed;

alter table public.profiles
  add constraint profiles_emergency_contact_relationship_allowed
  check (
    emergency_contact_relationship is null
    or emergency_contact_relationship in (
      'spouse',
      'partner',
      'parent',
      'child',
      'sibling',
      'friend',
      'other'
    )
  );

alter table public.profiles
  drop constraint if exists profiles_blood_type_allowed;

alter table public.profiles
  add constraint profiles_blood_type_allowed
  check (
    blood_type is null
    or blood_type in (
      'A+',
      'A-',
      'B+',
      'B-',
      'AB+',
      'AB-',
      'O+',
      'O-',
      'Unknown'
    )
  );

create index if not exists profiles_emergency_info_completed_at_idx
  on public.profiles (emergency_info_completed_at);

-- RLS policies from SCRUM-17 (select/insert/update own) already cover these columns.
-- No new policies or grants required.
-- Completing this step must not set preferences_completed_at (SCRUM-18).
