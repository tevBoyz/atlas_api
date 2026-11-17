-- SCRUM-27 / 28 / 29 follow-up: qualify columns that clash with RPC args.
-- Hosted Add Member failed with: column reference "phone" is ambiguous
-- because invite_circle_member_by_phone(phone) clashed with
-- safety_circle_members.phone in WHERE (and the unique_violation retry).
-- RPC argument names and return JSON keys are unchanged.

-- ---------------------------------------------------------------------------
-- Internal: qualify id so invite/resend refresh cannot clash later
-- ---------------------------------------------------------------------------

create or replace function public._refresh_circle_invite(
  p_member_id uuid,
  err_prefix text,
  p_display_name text default null,
  p_relationship text default null
)
returns public.safety_circle_members
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.safety_circle_members%rowtype;
  new_name text;
  new_rel text;
begin
  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.id = p_member_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':member_not_found';
  end if;

  if m.role <> 'member' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_invitable';
  end if;

  if m.status = 'active' or m.invite_consumed_at is not null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':already_active';
  end if;

  new_name := coalesce(nullif(trim(p_display_name), ''), m.display_name);
  if char_length(new_name) = 0 then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':invalid_display_name';
  end if;

  if p_relationship is null then
    new_rel := m.relationship;
  else
    new_rel := nullif(trim(p_relationship), '');
  end if;

  if new_rel is not null
     and new_rel not in (
       'spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'other'
     ) then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':invalid_relationship';
  end if;

  update public.safety_circle_members
     set display_name = new_name,
         relationship = new_rel,
         status = 'pending',
         user_id = null,
         invited_at = now(),
         invite_token = public.new_circle_invite_token(),
         invite_expires_at = now() + interval '7 days',
         invite_consumed_at = null,
         invite_canceled_at = null,
         updated_at = now()
   where public.safety_circle_members.id = p_member_id
   returning * into m;

  return m;
end;
$$;

comment on function public._refresh_circle_invite(uuid, text, text, text) is
  'SCRUM-27: Rotate token, refresh invited_at + 7-day expiry, set pending. Never regresses active. Internal. Columns qualified vs args.';

-- ---------------------------------------------------------------------------
-- invite_circle_member_by_phone — keep args display_name, phone, relationship
-- ---------------------------------------------------------------------------

create or replace function public.invite_circle_member_by_phone(
  display_name text,
  phone text,
  relationship text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'invite_circle_member_by_phone';
  cid uuid;
  raw_phone text;
  raw_name text;
  raw_rel text;
  existing public.safety_circle_members%rowtype;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  raw_name := trim(coalesce(display_name, ''));
  if char_length(raw_name) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_display_name';
  end if;

  raw_phone := trim(coalesce(phone, ''));
  if raw_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_phone';
  end if;

  raw_rel := nullif(trim(coalesce(relationship, '')), '');
  if raw_rel is not null
     and raw_rel not in (
       'spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'other'
     ) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_relationship';
  end if;

  select *
    into existing
    from public.safety_circle_members
   where public.safety_circle_members.circle_id = cid
     and public.safety_circle_members.phone = raw_phone
   for update;

  if found then
    created := public._refresh_circle_invite(
      existing.id,
      prefix,
      raw_name,
      coalesce(raw_rel, existing.relationship)
    );
    return public._circle_invite_payload(created, true);
  end if;

  begin
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
      cid,
      'member',
      'pending',
      raw_name,
      raw_rel,
      raw_phone,
      null,
      null,
      now(),
      public.new_circle_invite_token(),
      now() + interval '7 days'
    )
    returning * into created;
  exception
    when unique_violation then
      select *
        into existing
        from public.safety_circle_members
       where public.safety_circle_members.circle_id = cid
         and public.safety_circle_members.phone = raw_phone
       for update;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':duplicate_membership';
      end if;

      created := public._refresh_circle_invite(
        existing.id,
        prefix,
        raw_name,
        coalesce(raw_rel, existing.relationship)
      );
      return public._circle_invite_payload(created, true);
  end;

  return public._circle_invite_payload(created, false);
end;
$$;

comment on function public.invite_circle_member_by_phone(text, text, text) is
  'SCRUM-27: Owner-only. Validate E.164 then insert a pending member with unique token + 7-day expiry, or resend an existing non-active row for that phone. Args kept; safety_circle_members.phone / circle_id qualified. Does not send SMS. Does not write profiles.emergency_*. Never regresses active.';

-- ---------------------------------------------------------------------------
-- create_circle_invite_link(display_name)
-- ---------------------------------------------------------------------------

create or replace function public.create_circle_invite_link(
  display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'create_circle_invite_link';
  cid uuid;
  raw_name text;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  raw_name := nullif(trim(coalesce(display_name, '')), '');
  if raw_name is null then
    raw_name := 'Invited member';
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
    invited_at,
    invite_token,
    invite_expires_at
  )
  values (
    cid,
    'member',
    'pending',
    raw_name,
    null,
    null,
    null,
    null,
    now(),
    public.new_circle_invite_token(),
    now() + interval '7 days'
  )
  returning * into created;

  return public._circle_invite_payload(created, false);
end;
$$;

comment on function public.create_circle_invite_link(text) is
  'SCRUM-27: Owner-only. Pending member with unique token, phone null, 7-day expiry. Share io.supabase.atlasmobile://invite/{token}. Does not send SMS. INSERT uses table alias so display_name arg cannot clash.';

-- ---------------------------------------------------------------------------
-- resend_circle_invite(member_id)
-- ---------------------------------------------------------------------------

create or replace function public.resend_circle_invite(member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'resend_circle_invite';
  cid uuid;
  existing public.safety_circle_members%rowtype;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  if member_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':member_not_found';
  end if;

  select *
    into existing
    from public.safety_circle_members
   where public.safety_circle_members.id = member_id
     and public.safety_circle_members.circle_id = cid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':member_not_found';
  end if;

  created := public._refresh_circle_invite(existing.id, prefix);
  return public._circle_invite_payload(created, true);
end;
$$;

comment on function public.resend_circle_invite(uuid) is
  'SCRUM-27: Owner-only. Rotate token, refresh invited_at + 7-day expiry. Expired/declined/canceled become pending. Active/consumed errors. Does not send SMS. Columns qualified vs member_id arg.';

-- ---------------------------------------------------------------------------
-- preview_circle_invite(token)
-- ---------------------------------------------------------------------------

create or replace function public.preview_circle_invite(token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'preview_circle_invite';
  uid uuid;
  auth_phone text;
  raw text := trim(coalesce(token, ''));
  m public.safety_circle_members%rowtype;
  st text;
  recipient_ok boolean;
  claimed boolean := false;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  if char_length(raw) = 0 then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null,
      'member_id', null,
      'circle_id', null,
      'owner_name', null,
      'invited_at', null,
      'claimed', false,
      'recipient_ok', false
    );
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.invite_token = raw
   for update;

  if not found then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null,
      'member_id', null,
      'circle_id', null,
      'owner_name', null,
      'invited_at', null,
      'claimed', false,
      'recipient_ok', false
    );
  end if;

  st := public._circle_invite_lookup_status(m);
  recipient_ok := public._circle_invite_recipient_ok(m, uid, auth_phone);

  if st = 'pending' and recipient_ok then
    if public._circle_has_active_membership(m.circle_id, uid, m.id) then
      raise exception using
        errcode = 'P0001',
        message = prefix || ':already_member';
    end if;

    if m.user_id is null then
      begin
        update public.safety_circle_members
           set user_id = uid,
               updated_at = now()
         where public.safety_circle_members.id = m.id
         returning * into m;
        claimed := true;
      exception
        when unique_violation then
          raise exception using
            errcode = 'P0001',
            message = prefix || ':duplicate_membership';
      end;
    else
      claimed := true;
    end if;
  elsif recipient_ok and m.user_id = uid then
    claimed := true;
  end if;

  return public._circle_invite_preview_payload(m, st, recipient_ok, claimed);
end;
$$;

comment on function public.preview_circle_invite(text) is
  'SCRUM-28: Authenticated invite preview (owner_name + invited_at). Claims pending tokens (sets user_id, keeps pending). Does not consume. No emergency/profile fields. invite_token / id columns qualified.';

-- ---------------------------------------------------------------------------
-- accept_circle_invite(token)
-- ---------------------------------------------------------------------------

create or replace function public.accept_circle_invite(token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'accept_circle_invite';
  uid uuid;
  auth_phone text;
  raw text := trim(coalesce(token, ''));
  m public.safety_circle_members%rowtype;
  st text;
  sharing boolean;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  if char_length(raw) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.invite_token = raw
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  st := public._circle_invite_lookup_status(m);
  perform public._reject_unless_pending(prefix, st);

  if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_recipient';
  end if;

  if public._circle_has_active_membership(m.circle_id, uid, m.id) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':already_member';
  end if;

  select p.location_sharing_enabled
    into sharing
    from public.profiles p
   where p.id = uid;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':profile_not_found';
  end if;

  if not sharing then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':location_sharing_disabled';
  end if;

  begin
    update public.safety_circle_members
       set user_id = uid,
           status = 'active',
           invite_consumed_at = now(),
           invite_canceled_at = null,
           updated_at = now()
     where public.safety_circle_members.id = m.id
     returning * into m;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = prefix || ':duplicate_membership';
  end;

  return jsonb_build_object(
    'circle_id', m.circle_id,
    'member_id', m.id,
    'status', m.status,
    'owner_name', public._circle_owner_display_name(m.circle_id)
  );
end;
$$;

comment on function public.accept_circle_invite(text) is
  'SCRUM-28: Pending + recipient + location_sharing_enabled only. Sets user_id, active, invite_consumed_at. Token single-use. Does not send push/SMS/email. invite_token / id columns qualified.';

-- ---------------------------------------------------------------------------
-- decline_circle_invite(token)
-- ---------------------------------------------------------------------------

create or replace function public.decline_circle_invite(token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'decline_circle_invite';
  uid uuid;
  auth_phone text;
  raw text := trim(coalesce(token, ''));
  m public.safety_circle_members%rowtype;
  st text;
  claimed_uid uuid;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  if char_length(raw) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.invite_token = raw
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  st := public._circle_invite_lookup_status(m);
  perform public._reject_unless_pending(prefix, st);

  if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_recipient';
  end if;

  claimed_uid := uid;
  begin
    update public.safety_circle_members
       set user_id = claimed_uid,
           status = 'declined',
           invite_canceled_at = now(),
           invite_consumed_at = null,
           updated_at = now()
     where public.safety_circle_members.id = m.id
     returning * into m;
  exception
    when unique_violation then
      update public.safety_circle_members
         set status = 'declined',
             invite_canceled_at = now(),
             invite_consumed_at = null,
             updated_at = now()
       where public.safety_circle_members.id = m.id
       returning * into m;
  end;

  return jsonb_build_object(
    'circle_id', m.circle_id,
    'member_id', m.id,
    'status', m.status
  );
end;
$$;

comment on function public.decline_circle_invite(text) is
  'SCRUM-28: Pending only. Sets declined + invite_canceled_at. Does not grant circle access or consume-as-accept. Location sharing not required. No SMS/push/email. invite_token / id columns qualified.';

-- ---------------------------------------------------------------------------
-- list_circle_members(circle_id) — arg already function-qualified; keep that
-- ---------------------------------------------------------------------------

create or replace function public.list_circle_members(circle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  prefix constant text := 'list_circle_members';
  uid uuid;
  circle_exists boolean := false;
  caller_is_owner boolean := false;
  caller_is_active boolean := false;
begin
  uid := public._require_auth_uid(prefix);

  if list_circle_members.circle_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = list_circle_members.circle_id
  )
    into circle_exists;

  if not circle_exists then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = list_circle_members.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  select exists (
    select 1
      from public.safety_circle_members m
     where m.circle_id = list_circle_members.circle_id
       and m.user_id = uid
       and m.status = 'active'
  )
    into caller_is_active;

  if not caller_is_owner and not caller_is_active then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  return (
    select coalesce(
      jsonb_agg(payload order by sort_owner desc, sort_status, display_sort, invited_sort),
      '[]'::jsonb
    )
    from (
      select
        case
          when caller_is_owner then
            jsonb_build_object(
              'member_id', scm.id,
              'role', scm.role,
              'status', scm.status,
              'display_name', scm.display_name,
              'is_owner', scm.role = 'owner',
              'invited_at', scm.invited_at,
              'user_id', scm.user_id,
              'avatar_url', case
                when scm.user_id is not null
                then public._member_avatar_url(scm.user_id)
                else null
              end,
              'phone', scm.phone,
              'email', scm.email,
              'relationship', scm.relationship,
              'invite_expires_at', scm.invite_expires_at,
              'invite_consumed_at', scm.invite_consumed_at,
              'invite_canceled_at', scm.invite_canceled_at
            )
          else
            jsonb_build_object(
              'member_id', scm.id,
              'role', scm.role,
              'status', scm.status,
              'display_name', scm.display_name,
              'is_owner', scm.role = 'owner',
              'invited_at', scm.invited_at,
              'user_id', scm.user_id,
              'avatar_url', case
                when scm.user_id is not null
                then public._member_avatar_url(scm.user_id)
                else null
              end
            )
        end as payload,
        (scm.role = 'owner') as sort_owner,
        case scm.status
          when 'active' then 0
          when 'pending' then 1
          when 'declined' then 2
          else 3
        end as sort_status,
        lower(scm.display_name) as display_sort,
        scm.invited_at as invited_sort
      from public.safety_circle_members scm
      where scm.circle_id = list_circle_members.circle_id
        and (
          caller_is_owner
          or scm.status in ('pending', 'active')
        )
    ) listed
  );
end;
$$;

comment on function public.list_circle_members(uuid) is
  'SCRUM-29: Owner or active member lists members of that circle. Invitees get name/role/status/avatar only. Owner also gets phone/email/relationship/invite stamps. No emergency_*, medical, share flags, or invite tokens. Arg circle_id vs column: function-qualified arg + aliased columns.';

-- ---------------------------------------------------------------------------
-- remove_circle_member(member_id)
-- ---------------------------------------------------------------------------

create or replace function public.remove_circle_member(member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'remove_circle_member';
  uid uuid;
  m public.safety_circle_members%rowtype;
  caller_is_owner boolean := false;
begin
  uid := public._require_auth_uid(prefix);

  if member_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.id = member_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = m.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  if not caller_is_owner then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  if m.role = 'owner' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':cannot_remove_owner';
  end if;

  delete from public.safety_circle_members
   where public.safety_circle_members.id = m.id;

  return jsonb_build_object(
    'member_id', m.id,
    'circle_id', m.circle_id,
    'removed', true
  );
end;
$$;

comment on function public.remove_circle_member(uuid) is
  'SCRUM-29: Owner-only. Deletes a non-owner member row (pending/active/declined). Cannot remove the owner or the circle. Does not write profiles.emergency_*. No SMS/push. id column qualified vs member_id arg.';

-- ---------------------------------------------------------------------------
-- leave_safety_circle(circle_id) — bare circle_id in WHERE would clash
-- ---------------------------------------------------------------------------

create or replace function public.leave_safety_circle(circle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'leave_safety_circle';
  uid uuid;
  circle_exists boolean := false;
  caller_is_owner boolean := false;
  m public.safety_circle_members%rowtype;
begin
  uid := public._require_auth_uid(prefix);

  if leave_safety_circle.circle_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = leave_safety_circle.circle_id
  )
    into circle_exists;

  if not circle_exists then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = leave_safety_circle.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  if caller_is_owner then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':is_owner';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.circle_id = leave_safety_circle.circle_id
     and public.safety_circle_members.user_id = uid
     and public.safety_circle_members.status = 'active'
     and public.safety_circle_members.role = 'member'
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  delete from public.safety_circle_members
   where public.safety_circle_members.id = m.id;

  return jsonb_build_object(
    'circle_id', m.circle_id,
    'member_id', m.id,
    'left', true
  );
end;
$$;

comment on function public.leave_safety_circle(uuid) is
  'SCRUM-29: Active non-owner deletes their membership row so they drop from the list and from list_my_joined_circles. Owner cannot leave. Does not delete the circle. No SMS/push. safety_circle_members.circle_id qualified vs arg.';

-- ---------------------------------------------------------------------------
-- Grants (CREATE OR REPLACE keeps them; restated)
-- ---------------------------------------------------------------------------

revoke all on function public._refresh_circle_invite(uuid, text, text, text) from public;
revoke all on function public._refresh_circle_invite(uuid, text, text, text) from anon;
revoke all on function public._refresh_circle_invite(uuid, text, text, text) from authenticated;

revoke all on function public.invite_circle_member_by_phone(text, text, text) from public;
revoke all on function public.invite_circle_member_by_phone(text, text, text) from anon;
grant execute on function public.invite_circle_member_by_phone(text, text, text) to authenticated;

revoke all on function public.create_circle_invite_link(text) from public;
revoke all on function public.create_circle_invite_link(text) from anon;
grant execute on function public.create_circle_invite_link(text) to authenticated;

revoke all on function public.resend_circle_invite(uuid) from public;
revoke all on function public.resend_circle_invite(uuid) from anon;
grant execute on function public.resend_circle_invite(uuid) to authenticated;

revoke all on function public.preview_circle_invite(text) from public;
revoke all on function public.preview_circle_invite(text) from anon;
grant execute on function public.preview_circle_invite(text) to authenticated;

revoke all on function public.accept_circle_invite(text) from public;
revoke all on function public.accept_circle_invite(text) from anon;
grant execute on function public.accept_circle_invite(text) to authenticated;

revoke all on function public.decline_circle_invite(text) from public;
revoke all on function public.decline_circle_invite(text) from anon;
grant execute on function public.decline_circle_invite(text) to authenticated;

revoke all on function public.list_circle_members(uuid) from public;
revoke all on function public.list_circle_members(uuid) from anon;
grant execute on function public.list_circle_members(uuid) to authenticated;

revoke all on function public.remove_circle_member(uuid) from public;
revoke all on function public.remove_circle_member(uuid) from anon;
grant execute on function public.remove_circle_member(uuid) to authenticated;

revoke all on function public.leave_safety_circle(uuid) from public;
revoke all on function public.leave_safety_circle(uuid) from anon;
grant execute on function public.leave_safety_circle(uuid) to authenticated;
