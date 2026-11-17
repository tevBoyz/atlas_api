-- SCRUM-24: Per-Field Privacy Controls
-- Additive share-during-incident flags on public.profiles (lean V1).
-- One boolean per emergency-profile field from SCRUM-79.
-- Reuses emergency_notes_shareable (SCRUM-22) — do not add a second notes flag.
-- Defaults OFF (false) — no hidden opt-in.
-- Does not alter SCRUM-17/18/23/22/79/80 columns, RLS, or completion timestamps.
-- No Edge Functions. No incident / responder schema.

-- ---------------------------------------------------------------------------
-- Share-during-incident flags (default OFF)
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists share_emergency_contact_full_name boolean not null default false,
  add column if not exists share_emergency_contact_relationship boolean not null default false,
  add column if not exists share_emergency_contact_phone boolean not null default false,
  add column if not exists share_emergency_contact_email boolean not null default false,
  add column if not exists share_blood_type boolean not null default false,
  add column if not exists share_allergies boolean not null default false,
  add column if not exists share_medical_conditions boolean not null default false,
  add column if not exists share_emergency_preferred_language boolean not null default false;

comment on column public.profiles.share_emergency_contact_full_name is
  'SCRUM-24: Share emergency_contact_full_name during an incident. Default false — no hidden opt-in. Incident/responder reads MUST omit the field when false.';
comment on column public.profiles.share_emergency_contact_relationship is
  'SCRUM-24: Share emergency_contact_relationship during an incident. Default false — no hidden opt-in. Incident/responder reads MUST omit the field when false.';
comment on column public.profiles.share_emergency_contact_phone is
  'SCRUM-24: Share emergency_contact_phone during an incident. Default false — no hidden opt-in. Incident/responder reads MUST omit the field when false.';
comment on column public.profiles.share_emergency_contact_email is
  'SCRUM-24: Share emergency_contact_email during an incident. Default false — no hidden opt-in. Incident/responder reads MUST omit the field when false.';
comment on column public.profiles.share_blood_type is
  'SCRUM-24: Share blood_type during an incident. Default false — no hidden opt-in. Incident/responder reads MUST omit the field when false.';
comment on column public.profiles.share_allergies is
  'SCRUM-24: Share allergies during an incident. Default false — no hidden opt-in. Incident/responder reads MUST omit the field when false.';
comment on column public.profiles.share_medical_conditions is
  'SCRUM-24: Share medical_conditions during an incident. Default false — no hidden opt-in. Incident/responder reads MUST omit the field when false.';
comment on column public.profiles.share_emergency_preferred_language is
  'SCRUM-24: Share emergency_preferred_language during an incident. Default false — no hidden opt-in. Incident/responder reads MUST omit the field when false.';

-- RLS policies from SCRUM-17 (select/insert/update own) already cover these columns.
-- No new policies or grants required.
-- Notes sharing stays on emergency_notes_shareable (SCRUM-22).
-- Do not add share flags for personal-info (17) or location / alert prefs (18).
-- Incident / responder display is a later handoff; no cross-user SELECT here.
