-- SCRUM-36: One-Tap Emergency Activation
-- Creates public.incidents + start_emergency_activation(). Writes status
-- activating only. Does not notify, snapshot share flags, attach GPS, or
-- add type/notes. Cancel / send / resolve RPCs are SCRUM-42 / 43 / 45 / 46.
-- Hosted Supabase, no Express, no Edge Functions, no FCM, no Twilio.

-- ---------------------------------------------------------------------------
-- public.incidents
-- ---------------------------------------------------------------------------

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid not null references public.profiles (id) on delete cascade,
  circle_id uuid null references public.safety_circles (id) on delete set null,
  status text not null,
  activated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint incidents_status_allowed
    check (status in ('activating', 'active', 'cancelled', 'resolved'))
);

comment on table public.incidents is
  'SCRUM-36: Emergency loop. One open incident per resident (activating or active). 36 writes activating only. Not a sent alert.';
comment on column public.incidents.resident_id is
  'Activating resident. FK → profiles.id (same as auth.users.id).';
comment on column public.incidents.circle_id is
  'Owner safety_circles.id when the resident has a circle; else null. Location sharing off still allows start.';
comment on column public.incidents.status is
  'activating (36) | active (43) | cancelled (42) | resolved (45/46). 36 never writes active/cancelled/resolved.';
comment on column public.incidents.activated_at is
  'First start time. Unchanged on idempotent retry.';

create unique index incidents_one_open_per_resident_uidx
  on public.incidents (resident_id)
  where status in ('activating', 'active');

create index incidents_resident_id_idx
  on public.incidents (resident_id);

create index incidents_circle_id_idx
  on public.incidents (circle_id)
  where circle_id is not null;

create or replace function public.set_incidents_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists incidents_set_updated_at on public.incidents;
create trigger incidents_set_updated_at
  before update on public.incidents
  for each row
  execute function public.set_incidents_updated_at();

alter table public.incidents enable row level security;

drop policy if exists "incidents_select_own" on public.incidents;
create policy "incidents_select_own"
  on public.incidents
  for select
  to authenticated
  using (auth.uid() = resident_id);

drop policy if exists "incidents_insert_own" on public.incidents;
create policy "incidents_insert_own"
  on public.incidents
  for insert
  to authenticated
  with check (
    auth.uid() = resident_id
    and status = 'activating'
    and (
      circle_id is null
      or exists (
        select 1
        from public.safety_circles c
        where c.id = circle_id
          and c.owner_id = auth.uid()
      )
    )
  );

drop policy if exists "incidents_update_own" on public.incidents;
create policy "incidents_update_own"
  on public.incidents
  for update
  to authenticated
  using (auth.uid() = resident_id)
  with check (auth.uid() = resident_id);

-- Active members (not pending invitees) can SELECT so SCRUM-48 is not blocked.
drop policy if exists "incidents_select_active_member" on public.incidents;
create policy "incidents_select_active_member"
  on public.incidents
  for select
  to authenticated
  using (
    circle_id is not null
    and exists (
      select 1
      from public.safety_circle_members m
      where m.circle_id = incidents.circle_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

comment on policy "incidents_select_own" on public.incidents is
  'SCRUM-36: Resident can SELECT own incidents, including activating.';
comment on policy "incidents_insert_own" on public.incidents is
  'SCRUM-36: Resident insert is activating only, own resident_id, own circle or null. App must use the RPC.';
comment on policy "incidents_update_own" on public.incidents is
  'SCRUM-36: Resident can UPDATE own rows. Cancel/send/resolve RPCs land in 42/43/45/46.';
comment on policy "incidents_select_active_member" on public.incidents is
  'SCRUM-36 / 48: Active circle members can SELECT. Pending/declined cannot. Does not notify (43).';

revoke all on table public.incidents from public;
revoke all on table public.incidents from anon;
revoke all on table public.incidents from authenticated;
grant select, insert, update on table public.incidents to authenticated;

-- ---------------------------------------------------------------------------
-- start_emergency_activation() — JWT user, idempotent, activating only
-- ---------------------------------------------------------------------------

create or replace function public.start_emergency_activation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  p public.profiles%rowtype;
  rec public.incidents%rowtype;
  v_circle_id uuid;
begin
  uid := public._require_auth_uid('start_emergency_activation');

  select *
    into p
    from public.profiles
   where id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'start_emergency_activation:profile_not_found';
  end if;

  if p.profile_setup_completed_at is null then
    raise exception using
      errcode = 'P0001',
      message = 'start_emergency_activation:profile_setup_incomplete';
  end if;

  select *
    into rec
    from public.incidents i
   where i.resident_id = uid
     and i.status in ('activating', 'active');

  if found then
    return jsonb_build_object(
      'id', rec.id,
      'resident_id', rec.resident_id,
      'circle_id', rec.circle_id,
      'status', rec.status,
      'activated_at', rec.activated_at
    );
  end if;

  select sc.id
    into v_circle_id
    from public.safety_circles sc
   where sc.owner_id = uid;

  insert into public.incidents as i (
    resident_id,
    circle_id,
    status,
    activated_at
  )
  values (
    uid,
    v_circle_id,
    'activating',
    now()
  )
  on conflict (resident_id) where (status in ('activating', 'active'))
  do nothing
  returning * into rec;

  if rec.id is null then
    select *
      into rec
      from public.incidents i
     where i.resident_id = uid
       and i.status in ('activating', 'active');
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'resident_id', rec.resident_id,
    'circle_id', rec.circle_id,
    'status', rec.status,
    'activated_at', rec.activated_at
  );
end;
$$;

comment on function public.start_emergency_activation() is
  'SCRUM-36: Start (or return) the resident open incident as activating. Idempotent while activating/active. Does not notify, attach GPS, or require a circle.';

revoke all on function public.start_emergency_activation() from public;
revoke all on function public.start_emergency_activation() from anon;
grant execute on function public.start_emergency_activation() to authenticated;
