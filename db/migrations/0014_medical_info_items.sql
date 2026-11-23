-- SCRUM-21 (Add/Edit Medical Information), decisions D51-D53: allergies and medical conditions
-- become lists of items the resident adds, edits and deletes one by one (D51), the medical info gets
-- a "last updated" time, and an open incident gets a LIVE copy of the shared info next to its
-- activation snapshot (D53).
--
-- Additive and backward compatible (AGENTS.md rule 4):
-- - two new tables `profile_allergies` and `profile_medical_conditions` (one row per item, owner-only,
--   written only by the API; deleting the user deletes their items);
-- - `profiles.medical_info_updated_at` (nullable): set by the API on every item change and on a
--   blood-type change; null until the first such change (also for back-filled profiles);
-- - `incidents.live_share_payload` (jsonb, nullable) + `incidents.live_share_updated_at`
--   (nullable): the latest shared info of an active incident, rewritten by the API when the resident
--   changes their emergency info during it. `incidents.share_payload` stays the activation snapshot
--   and is never rewritten.
-- - The old text columns `profiles.allergies` / `profiles.medical_conditions` stay: the API keeps
--   them equal to the items joined with ', ' (oldest first), so the old SQL functions keep working.
-- Back-fill: each existing non-blank `allergies` / `medical_conditions` text becomes ONE item (not
-- split; the resident edits it), only for a profile that has no item in that list yet, so a re-run
-- adds nothing. Re-runnable on a fresh database after the baseline.

create table if not exists public.profile_allergies (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_allergies_pkey primary key (id),
  constraint profile_allergies_user_id_fkey foreign key (user_id)
    references public.users (id) on delete cascade,
  -- The API trims and allows 1-100 characters; a back-filled text keeps its length.
  constraint profile_allergies_text_nonblank check (length(btrim(text)) > 0)
);

create table if not exists public.profile_medical_conditions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_medical_conditions_pkey primary key (id),
  constraint profile_medical_conditions_user_id_fkey foreign key (user_id)
    references public.users (id) on delete cascade,
  constraint profile_medical_conditions_text_nonblank check (length(btrim(text)) > 0)
);

comment on table public.profile_allergies is
  'SCRUM-21 (D51): one allergy of a resident per row. Written only by the API (owner-only). '
  'profiles.allergies is kept equal to the texts joined with '', '' (oldest first). Medical text: '
  'never logged or audited.';
comment on table public.profile_medical_conditions is
  'SCRUM-21 (D51): one medical condition of a resident per row. Written only by the API '
  '(owner-only). profiles.medical_conditions is kept equal to the texts joined with '', '' (oldest '
  'first). Medical text: never logged or audited.';

-- Oldest first per user; a case-insensitive duplicate in the same list is refused (the API checks it
-- first with the same lower(), this index is the backstop).
create index if not exists profile_allergies_user_created_idx
  on public.profile_allergies (user_id, created_at, id);
create unique index if not exists profile_allergies_user_text_uidx
  on public.profile_allergies (user_id, lower(text));
create index if not exists profile_medical_conditions_user_created_idx
  on public.profile_medical_conditions (user_id, created_at, id);
create unique index if not exists profile_medical_conditions_user_text_uidx
  on public.profile_medical_conditions (user_id, lower(text));

alter table public.profile_allergies enable row level security;
alter table public.profile_medical_conditions enable row level security;
revoke all on table public.profile_allergies from public;
revoke all on table public.profile_allergies from anon;
revoke all on table public.profile_allergies from authenticated;
revoke all on table public.profile_medical_conditions from public;
revoke all on table public.profile_medical_conditions from anon;
revoke all on table public.profile_medical_conditions from authenticated;

alter table public.profiles
  add column if not exists medical_info_updated_at timestamptz;

comment on column public.profiles.medical_info_updated_at is
  'SCRUM-21 (D51): when the medical info last changed (an allergy or condition added, edited or '
  'deleted, or the blood type changed). Set by the API; null before the first change.';

alter table public.incidents
  add column if not exists live_share_payload jsonb,
  add column if not exists live_share_updated_at timestamptz;

comment on column public.incidents.live_share_payload is
  'SCRUM-21 (D53): the resident''s latest shared info while the incident is active (same shape as '
  'share_payload), rewritten by the API when they change it. Null = unchanged since activation. '
  'share_payload stays the activation snapshot.';
comment on column public.incidents.live_share_updated_at is
  'SCRUM-21 (D53): when live_share_payload was last rewritten.';

-- Back-fill: one item per non-blank text (whitespace trimmed at both ends), never twice.
insert into public.profile_allergies (user_id, text)
select p.id, regexp_replace(p.allergies, '^\s+|\s+$', '', 'g')
  from public.profiles p
 where regexp_replace(coalesce(p.allergies, ''), '^\s+|\s+$', '', 'g') <> ''
   and not exists (select 1 from public.profile_allergies a where a.user_id = p.id);

insert into public.profile_medical_conditions (user_id, text)
select p.id, regexp_replace(p.medical_conditions, '^\s+|\s+$', '', 'g')
  from public.profiles p
 where regexp_replace(coalesce(p.medical_conditions, ''), '^\s+|\s+$', '', 'g') <> ''
   and not exists (select 1 from public.profile_medical_conditions c where c.user_id = p.id);
