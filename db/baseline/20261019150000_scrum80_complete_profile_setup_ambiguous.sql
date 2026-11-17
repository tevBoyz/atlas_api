-- SCRUM-80 / 27 follow-up: rename complete_profile_setup() locals.
-- Hosted Complete failed with: column reference "circle_id" is ambiguous
-- because PL/pgSQL variables clashed with safety_circle_members.circle_id
-- in INSERT / ON CONFLICT. Return JSON keys and 27 invite-token behavior
-- are unchanged.

create or replace function public.complete_profile_setup()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p public.profiles%rowtype;
  v_circle_id uuid;
  v_member_id uuid;
  v_member_status text;
  v_completed_at timestamptz;
  v_contact_email text;
  v_invite_tok text;
  v_invite_exp timestamptz;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:not_authenticated';
  end if;

  select *
    into p
    from public.profiles
   where public.profiles.id = uid
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
     set profile_setup_completed_at = coalesce(
           public.profiles.profile_setup_completed_at,
           now()
         )
   where public.profiles.id = uid
   returning public.profiles.profile_setup_completed_at into v_completed_at;

  if not p.location_sharing_enabled then
    return jsonb_build_object(
      'profile_setup_completed_at', v_completed_at,
      'location_sharing_enabled', false,
      'circle_id', null,
      'member_id', null,
      'member_status', null
    );
  end if;

  select sc.id
    into v_circle_id
    from public.safety_circles sc
   where sc.owner_id = uid;

  if v_circle_id is null then
    insert into public.safety_circles as sc (owner_id, name)
    values (uid, 'My Safety Circle')
    returning sc.id into v_circle_id;
  end if;

  insert into public.safety_circle_members as scm (
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
    v_circle_id,
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

  v_contact_email := nullif(trim(coalesce(p.emergency_contact_email, '')), '');
  v_invite_tok := public.new_circle_invite_token();
  v_invite_exp := now() + interval '7 days';

  insert into public.safety_circle_members as scm (
    circle_id,
    role,
    status,
    display_name,
    relationship,
    phone,
    email,
    user_id,
    invited_at,
    invite_token,
    invite_expires_at
  )
  values (
    v_circle_id,
    'member',
    'pending',
    trim(p.emergency_contact_full_name),
    p.emergency_contact_relationship,
    p.emergency_contact_phone,
    v_contact_email,
    null,
    now(),
    v_invite_tok,
    v_invite_exp
  )
  on conflict (circle_id, phone) where phone is not null
  do update set
    display_name = excluded.display_name,
    relationship = excluded.relationship,
    email = excluded.email,
    status = case
      when scm.status = 'active' then 'active'
      else 'pending'
    end,
    invited_at = case
      when scm.status = 'active'
        then scm.invited_at
      else now()
    end,
    invite_token = case
      when scm.status = 'active'
        then scm.invite_token
      when scm.status = 'pending'
           and scm.invite_token is not null
        then scm.invite_token
      else excluded.invite_token
    end,
    invite_expires_at = case
      when scm.status = 'active'
        then scm.invite_expires_at
      else excluded.invite_expires_at
    end,
    updated_at = now()
  returning scm.id, scm.status into v_member_id, v_member_status;

  return jsonb_build_object(
    'profile_setup_completed_at', v_completed_at,
    'location_sharing_enabled', true,
    'circle_id', v_circle_id,
    'member_id', v_member_id,
    'member_status', v_member_status
  );
end;
$$;

comment on function public.complete_profile_setup() is
  'SCRUM-80 / 27: Atomic Complete. Locals are v_* so INSERT/ON CONFLICT does not clash with safety_circle_members.circle_id. Sets profile_setup_completed_at. If location_sharing_enabled, ensures My Safety Circle + owner active member + emergency contact pending invite with token + 7-day expiry. Does not send SMS/email. Does not consume tokens. Return JSON keys unchanged.';

revoke all on function public.complete_profile_setup() from public;
revoke all on function public.complete_profile_setup() from anon;
grant execute on function public.complete_profile_setup() to authenticated;
