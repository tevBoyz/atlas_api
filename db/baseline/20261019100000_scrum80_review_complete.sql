-- SCRUM-80: Review & Complete Profile Setup
-- Completes onboarding (profile_setup_completed_at) and, when Location Sharing
-- is on, creates the minimum SCRUM-26 Safety Circle + Pending invite for the
-- designated emergency contact. Lean V1 — hosted Supabase, no Express, no SMS/email.

-- ---------------------------------------------------------------------------
-- profiles: onboarding-complete timestamp (no review snapshot table)
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists profile_setup_completed_at timestamptz null;

comment on column public.profiles.profile_setup_completed_at is
  'SCRUM-80: Set by complete_profile_setup() when Review Save & Complete Setup succeeds. Null means profile setup is still needed. Idempotent: first success wins.';

create index if not exists profiles_profile_setup_completed_at_idx
  on public.profiles (profile_setup_completed_at);

-- ---------------------------------------------------------------------------
-- public.safety_circles — one personal circle per owner (minimum SCRUM-26)
-- ---------------------------------------------------------------------------

create table if not exists public.safety_circles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  name text not null default 'My Safety Circle',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint safety_circles_name_nonempty
    check (char_length(trim(name)) > 0)
);

comment on table public.safety_circles is
  'SCRUM-80 / minimum SCRUM-26: One personal Safety Circle per resident (owner_id unique). Created on Complete only when location_sharing_enabled is true.';
comment on column public.safety_circles.owner_id is
  'Circle owner. FK → profiles.id (same as auth.users.id). One circle per owner.';
comment on column public.safety_circles.name is
  'Display name. V1 default My Safety Circle. Do not overwrite on Complete if the row already exists.';

create or replace function public.set_safety_circles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists safety_circles_set_updated_at on public.safety_circles;
create trigger safety_circles_set_updated_at
  before update on public.safety_circles
  for each row
  execute function public.set_safety_circles_updated_at();

alter table public.safety_circles enable row level security;

drop policy if exists "safety_circles_select_own" on public.safety_circles;
create policy "safety_circles_select_own"
  on public.safety_circles
  for select
  to authenticated
  using (auth.uid() = owner_id);

drop policy if exists "safety_circles_insert_own" on public.safety_circles;
create policy "safety_circles_insert_own"
  on public.safety_circles
  for insert
  to authenticated
  with check (auth.uid() = owner_id);

drop policy if exists "safety_circles_update_own" on public.safety_circles;
create policy "safety_circles_update_own"
  on public.safety_circles
  for update
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

grant select, insert, update on table public.safety_circles to authenticated;

-- ---------------------------------------------------------------------------
-- public.safety_circle_members — owner (active) + pending invitees
-- ---------------------------------------------------------------------------

create table if not exists public.safety_circle_members (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.safety_circles (id) on delete cascade,
  role text not null,
  status text not null,
  display_name text not null,
  relationship text null,
  phone text null,
  email text null,
  user_id uuid null references auth.users (id) on delete set null,
  invited_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint safety_circle_members_role_allowed
    check (role in ('owner', 'member')),
  constraint safety_circle_members_status_allowed
    check (status in ('pending', 'active', 'declined')),
  constraint safety_circle_members_display_name_nonempty
    check (char_length(trim(display_name)) > 0),
  constraint safety_circle_members_relationship_allowed
    check (
      relationship is null
      or relationship in (
        'spouse',
        'partner',
        'parent',
        'child',
        'sibling',
        'friend',
        'other'
      )
    ),
  constraint safety_circle_members_phone_e164
    check (
      phone is null
      or phone ~ '^\+[1-9][0-9]{7,14}$'
    ),
  constraint safety_circle_members_owner_shape
    check (
      (role = 'owner' and status = 'active' and user_id is not null)
      or role = 'member'
    )
);

comment on table public.safety_circle_members is
  'SCRUM-80 / minimum SCRUM-26: Circle membership. Pending rows are invites (no SMS/email in V1). user_id is null until accept/match (SCRUM-28).';
comment on column public.safety_circle_members.role is
  'owner | member. One owner per circle.';
comment on column public.safety_circle_members.status is
  'pending | active | declined. Complete writes pending for the emergency contact. SCRUM-28 uses active/declined.';
comment on column public.safety_circle_members.display_name is
  'Invitee or owner display name. Copied from profiles.emergency_contact_full_name for the first pending member.';
comment on column public.safety_circle_members.relationship is
  'Optional. Same stored values as profiles.emergency_contact_relationship.';
comment on column public.safety_circle_members.phone is
  'E.164 including +220. Unique per circle when not null. Used to prevent duplicate pending invites.';
comment on column public.safety_circle_members.email is
  'Optional invitee email. Copied from profiles.emergency_contact_email.';
comment on column public.safety_circle_members.user_id is
  'Null until the invitee accepts or is matched to an Auth account (SCRUM-28). Owner always has user_id = owner.';
comment on column public.safety_circle_members.invited_at is
  'When this invite/membership was last issued. Owner uses circle-create time.';

create unique index if not exists safety_circle_members_circle_phone_uidx
  on public.safety_circle_members (circle_id, phone)
  where phone is not null;

create unique index if not exists safety_circle_members_circle_user_uidx
  on public.safety_circle_members (circle_id, user_id)
  where user_id is not null;

create unique index if not exists safety_circle_members_one_owner_uidx
  on public.safety_circle_members (circle_id)
  where role = 'owner';

create index if not exists safety_circle_members_circle_id_idx
  on public.safety_circle_members (circle_id);

create index if not exists safety_circle_members_user_id_idx
  on public.safety_circle_members (user_id)
  where user_id is not null;

create or replace function public.set_safety_circle_members_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists safety_circle_members_set_updated_at on public.safety_circle_members;
create trigger safety_circle_members_set_updated_at
  before update on public.safety_circle_members
  for each row
  execute function public.set_safety_circle_members_updated_at();

alter table public.safety_circle_members enable row level security;

drop policy if exists "safety_circle_members_select_owner" on public.safety_circle_members;
create policy "safety_circle_members_select_owner"
  on public.safety_circle_members
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.safety_circles c
      where c.id = safety_circle_members.circle_id
        and c.owner_id = auth.uid()
    )
  );

drop policy if exists "safety_circle_members_select_self" on public.safety_circle_members;
create policy "safety_circle_members_select_self"
  on public.safety_circle_members
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "safety_circle_members_insert_owner" on public.safety_circle_members;
create policy "safety_circle_members_insert_owner"
  on public.safety_circle_members
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.safety_circles c
      where c.id = circle_id
        and c.owner_id = auth.uid()
    )
  );

drop policy if exists "safety_circle_members_update_owner" on public.safety_circle_members;
create policy "safety_circle_members_update_owner"
  on public.safety_circle_members
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.safety_circles c
      where c.id = safety_circle_members.circle_id
        and c.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.safety_circles c
      where c.id = safety_circle_members.circle_id
        and c.owner_id = auth.uid()
    )
  );

grant select, insert, update on table public.safety_circle_members to authenticated;

-- ---------------------------------------------------------------------------
-- complete_profile_setup() — atomic Complete under RLS
-- ---------------------------------------------------------------------------

create or replace function public.complete_profile_setup()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p public.profiles%rowtype;
  circle_id uuid;
  member_id uuid;
  member_status text;
  completed_at timestamptz;
  contact_email text;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:not_authenticated';
  end if;

  select *
    into p
    from public.profiles
   where id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:profile_not_found';
  end if;

  if p.personal_info_completed_at is null
     or char_length(trim(p.full_name)) = 0
     or p.date_of_birth is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:personal_info_incomplete';
  end if;

  if p.emergency_info_completed_at is null
     or p.emergency_contact_full_name is null
     or char_length(trim(p.emergency_contact_full_name)) = 0
     or p.emergency_contact_relationship is null
     or p.emergency_contact_phone is null
     or p.emergency_contact_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:emergency_info_incomplete';
  end if;

  if p.preferences_completed_at is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:preferences_incomplete';
  end if;

  update public.profiles
     set profile_setup_completed_at = coalesce(profile_setup_completed_at, now())
   where id = uid
   returning profile_setup_completed_at into completed_at;

  if not p.location_sharing_enabled then
    return jsonb_build_object(
      'profile_setup_completed_at', completed_at,
      'location_sharing_enabled', false,
      'circle_id', null,
      'member_id', null,
      'member_status', null
    );
  end if;

  select sc.id
    into circle_id
    from public.safety_circles sc
   where sc.owner_id = uid;

  if circle_id is null then
    insert into public.safety_circles (owner_id, name)
    values (uid, 'My Safety Circle')
    returning id into circle_id;
  end if;

  insert into public.safety_circle_members (
    circle_id,
    role,
    status,
    display_name,
    relationship,
    phone,
    email,
    user_id,
    invited_at
  )
  values (
    circle_id,
    'owner',
    'active',
    trim(p.full_name),
    null,
    null,
    null,
    uid,
    now()
  )
  on conflict (circle_id, user_id) where user_id is not null
  do update set
    display_name = excluded.display_name,
    role = 'owner',
    status = 'active',
    updated_at = now();

  contact_email := nullif(trim(coalesce(p.emergency_contact_email, '')), '');

  insert into public.safety_circle_members (
    circle_id,
    role,
    status,
    display_name,
    relationship,
    phone,
    email,
    user_id,
    invited_at
  )
  values (
    circle_id,
    'member',
    'pending',
    trim(p.emergency_contact_full_name),
    p.emergency_contact_relationship,
    p.emergency_contact_phone,
    contact_email,
    null,
    now()
  )
  on conflict (circle_id, phone) where phone is not null
  do update set
    display_name = excluded.display_name,
    relationship = excluded.relationship,
    email = excluded.email,
    status = case
      when public.safety_circle_members.status = 'active' then 'active'
      else 'pending'
    end,
    invited_at = case
      when public.safety_circle_members.status = 'active'
        then public.safety_circle_members.invited_at
      else now()
    end,
    updated_at = now()
  returning id, status into member_id, member_status;

  return jsonb_build_object(
    'profile_setup_completed_at', completed_at,
    'location_sharing_enabled', true,
    'circle_id', circle_id,
    'member_id', member_id,
    'member_status', member_status
  );
end;
$$;

comment on function public.complete_profile_setup() is
  'SCRUM-80: Atomic Complete. Sets profile_setup_completed_at. If location_sharing_enabled, ensures My Safety Circle + owner active member + emergency contact pending invite. Does not send SMS/email. The pending row is the invite.';

revoke all on function public.complete_profile_setup() from public;
revoke all on function public.complete_profile_setup() from anon;
grant execute on function public.complete_profile_setup() to authenticated;
