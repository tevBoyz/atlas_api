-- SCRUM-38: Emergency Type Selection
-- Adds incidents.emergency_type (default unspecified) and set_emergency_type().
-- Replaces start_emergency_activation() so every return includes emergency_type.
-- New inserts omit the column so the default applies. Type never delays send.
-- Does not notify, attach GPS, cancel, promote to active, or add notes.
-- Hosted Supabase, no Express, no Edge Functions, no FCM, no Twilio.

-- ---------------------------------------------------------------------------
-- public.incidents.emergency_type
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column emergency_type text not null default 'unspecified';

alter table public.incidents
  add constraint incidents_emergency_type_allowed
    check (emergency_type in (
      'medical',
      'fire',
      'crime_safety',
      'accident',
      'other',
      'unspecified'
    ));

comment on column public.incidents.emergency_type is
  'SCRUM-38: Emergency type. Default unspecified so send (42+43) is never blocked.';

-- ---------------------------------------------------------------------------
-- start_emergency_activation() — same 36 rules; return includes emergency_type
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
      'activated_at', rec.activated_at,
      'emergency_type', rec.emergency_type
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
    'activated_at', rec.activated_at,
    'emergency_type', rec.emergency_type
  );
end;
$$;

comment on function public.start_emergency_activation() is
  'SCRUM-36 / 38: Start (or return) the resident open incident as activating. Idempotent while activating/active. Return includes emergency_type. New inserts use default unspecified. Does not notify, attach GPS, or require a circle.';

revoke all on function public.start_emergency_activation() from public;
revoke all on function public.start_emergency_activation() from anon;
grant execute on function public.start_emergency_activation() to authenticated;

-- ---------------------------------------------------------------------------
-- set_emergency_type(p_incident_id, p_emergency_type)
-- Resident only. activating or active. Does not change status / send.
-- ---------------------------------------------------------------------------

create or replace function public.set_emergency_type(
  p_incident_id uuid,
  p_emergency_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('set_emergency_type');

  if p_emergency_type is null
     or p_emergency_type not in (
       'medical',
       'fire',
       'crime_safety',
       'accident',
       'other',
       'unspecified'
     )
  then
    raise exception using
      errcode = 'P0001',
      message = 'set_emergency_type:invalid_type';
  end if;

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'set_emergency_type:not_found';
  end if;

  if rec.status not in ('activating', 'active') then
    raise exception using
      errcode = 'P0001',
      message = 'set_emergency_type:not_open';
  end if;

  update public.incidents
     set emergency_type = p_emergency_type
   where id = rec.id
  returning * into rec;

  return jsonb_build_object(
    'id', rec.id,
    'resident_id', rec.resident_id,
    'circle_id', rec.circle_id,
    'status', rec.status,
    'activated_at', rec.activated_at,
    'emergency_type', rec.emergency_type
  );
end;
$$;

comment on function public.set_emergency_type(uuid, text) is
  'SCRUM-38: Set emergency_type on the caller''s activating or active incident. Does not change status, activated_at, circle_id, or resident_id. Does not send.';

revoke all on function public.set_emergency_type(uuid, text) from public;
revoke all on function public.set_emergency_type(uuid, text) from anon;
grant execute on function public.set_emergency_type(uuid, text) to authenticated;
