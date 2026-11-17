-- SCRUM-28: Accept or Decline Safety Circle invitations
-- Invitee SECURITY DEFINER RPCs. Does not send SMS/email/push (Twilio/SMTP/FCM
-- hold). Does not open owner profiles. Does not implement SCRUM-29 manage APIs.
-- Hosted Supabase, no Express, no Edge Functions.

-- ---------------------------------------------------------------------------
-- Comments / index
-- ---------------------------------------------------------------------------

comment on column public.safety_circle_members.invite_consumed_at is
  'SCRUM-28: Set when the invitee accepts. Token is then consumed (lookup status consumed). SCRUM-27 never writes this.';
comment on column public.safety_circle_members.invite_canceled_at is
  'SCRUM-28: Set when the invitee declines (with status = declined). Lookup treats this as canceled. SCRUM-27 resend clears it.';
comment on column public.safety_circle_members.user_id is
  'Null until SCRUM-28 claim (preview/list, status stays pending) or accept/decline. Unique per circle when not null.';

create index if not exists safety_circle_members_phone_list_idx
  on public.safety_circle_members (phone)
  where phone is not null and role = 'member';

-- ---------------------------------------------------------------------------
-- Joined-circle SELECT (active member). Does not open profiles.
-- ---------------------------------------------------------------------------

drop policy if exists "safety_circles_select_active_member" on public.safety_circles;
create policy "safety_circles_select_active_member"
  on public.safety_circles
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.safety_circle_members m
      where m.circle_id = safety_circles.id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

comment on policy "safety_circles_select_active_member" on public.safety_circles is
  'SCRUM-28: Active members (not only the owner) can SELECT the circle row they joined. Pending/declined cannot. Does not grant profiles or other members.';

-- ---------------------------------------------------------------------------
-- Internal helpers (not granted to anon / authenticated / PUBLIC)
-- ---------------------------------------------------------------------------

create or replace function public._require_auth_uid(err_prefix text)
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_authenticated';
  end if;
  return uid;
end;
$$;

comment on function public._require_auth_uid(text) is
  'SCRUM-28: Require auth.uid(). Internal.';

create or replace function public._auth_user_phone(uid uuid)
returns text
language sql
stable
set search_path = public
as $$
  select nullif(trim(u.phone), '')
    from auth.users u
   where u.id = uid;
$$;

comment on function public._auth_user_phone(uuid) is
  'SCRUM-28: Auth E.164 phone for uid. Internal.';

create or replace function public._circle_owner_display_name(cid uuid)
returns text
language sql
stable
set search_path = public
as $$
  select om.display_name
    from public.safety_circle_members om
   where om.circle_id = cid
     and om.role = 'owner'
   limit 1;
$$;

comment on function public._circle_owner_display_name(uuid) is
  'SCRUM-28: Owner member display_name (not profiles). Internal.';

create or replace function public._circle_invite_lookup_status(
  m public.safety_circle_members
)
returns text
language plpgsql
stable
set search_path = public
as $$
begin
  if m.invite_canceled_at is not null or m.status = 'declined' then
    return 'canceled';
  elsif m.invite_consumed_at is not null or m.status = 'active' then
    return 'consumed';
  elsif m.invite_expires_at is not null and m.invite_expires_at <= now() then
    return 'expired';
  elsif m.invite_expires_at is null
        and m.invited_at + interval '7 days' <= now() then
    return 'expired';
  elsif m.status = 'pending' then
    return 'pending';
  else
    return 'not_found';
  end if;
end;
$$;

comment on function public._circle_invite_lookup_status(public.safety_circle_members) is
  'SCRUM-28: Same precedence as lookup_circle_invite. Internal.';

create or replace function public._circle_invite_recipient_ok(
  m public.safety_circle_members,
  uid uuid,
  auth_phone text
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
begin
  if m.user_id is not null and m.user_id <> uid then
    return false;
  end if;

  if m.phone is not null then
    return auth_phone is not null and m.phone = auth_phone;
  end if;

  -- Link-only: possession of the current token is enough.
  return true;
end;
$$;

comment on function public._circle_invite_recipient_ok(public.safety_circle_members, uuid, text) is
  'SCRUM-28: Phone invites must match Auth E.164. Link-only (phone null) allows the token holder. Internal.';

create or replace function public._reject_unless_pending(err_prefix text, st text)
returns void
language plpgsql
immutable
set search_path = public
as $$
begin
  if st = 'pending' then
    return;
  elsif st = 'expired' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':expired';
  elsif st = 'consumed' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':consumed';
  elsif st = 'canceled' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':canceled';
  else
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_found';
  end if;
end;
$$;

comment on function public._reject_unless_pending(text, text) is
  'SCRUM-28: Raise lookup-status errors. Internal.';

create or replace function public._circle_has_active_membership(
  cid uuid,
  uid uuid,
  exclude_id uuid
)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.safety_circle_members x
     where x.circle_id = cid
       and x.user_id = uid
       and x.status = 'active'
       and x.id is distinct from exclude_id
  );
$$;

comment on function public._circle_has_active_membership(uuid, uuid, uuid) is
  'SCRUM-28: True if uid is already an active member (including owner) of the circle. Internal.';

create or replace function public._circle_invite_preview_payload(
  m public.safety_circle_members,
  st text,
  recipient_ok boolean,
  claimed boolean
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  if m.id is null then
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

  if not recipient_ok then
    return jsonb_build_object(
      'status', st,
      'invite_expires_at', m.invite_expires_at,
      'member_id', null,
      'circle_id', null,
      'owner_name', null,
      'invited_at', null,
      'claimed', false,
      'recipient_ok', false
    );
  end if;

  return jsonb_build_object(
    'status', st,
    'invite_expires_at', m.invite_expires_at,
    'member_id', m.id,
    'circle_id', m.circle_id,
    'owner_name', public._circle_owner_display_name(m.circle_id),
    'invited_at', m.invited_at,
    'claimed', claimed,
    'recipient_ok', true
  );
end;
$$;

comment on function public._circle_invite_preview_payload(public.safety_circle_members, text, boolean, boolean) is
  'SCRUM-28: Authenticated preview JSON. No emergency_*, medical, other members, or profiles. Internal.';

revoke all on function public._require_auth_uid(text) from public;
revoke all on function public._require_auth_uid(text) from anon;
revoke all on function public._require_auth_uid(text) from authenticated;

revoke all on function public._auth_user_phone(uuid) from public;
revoke all on function public._auth_user_phone(uuid) from anon;
revoke all on function public._auth_user_phone(uuid) from authenticated;

revoke all on function public._circle_owner_display_name(uuid) from public;
revoke all on function public._circle_owner_display_name(uuid) from anon;
revoke all on function public._circle_owner_display_name(uuid) from authenticated;

revoke all on function public._circle_invite_lookup_status(public.safety_circle_members) from public;
revoke all on function public._circle_invite_lookup_status(public.safety_circle_members) from anon;
revoke all on function public._circle_invite_lookup_status(public.safety_circle_members) from authenticated;

revoke all on function public._circle_invite_recipient_ok(public.safety_circle_members, uuid, text) from public;
revoke all on function public._circle_invite_recipient_ok(public.safety_circle_members, uuid, text) from anon;
revoke all on function public._circle_invite_recipient_ok(public.safety_circle_members, uuid, text) from authenticated;

revoke all on function public._reject_unless_pending(text, text) from public;
revoke all on function public._reject_unless_pending(text, text) from anon;
revoke all on function public._reject_unless_pending(text, text) from authenticated;

revoke all on function public._circle_has_active_membership(uuid, uuid, uuid) from public;
revoke all on function public._circle_has_active_membership(uuid, uuid, uuid) from anon;
revoke all on function public._circle_has_active_membership(uuid, uuid, uuid) from authenticated;

revoke all on function public._circle_invite_preview_payload(public.safety_circle_members, text, boolean, boolean) from public;
revoke all on function public._circle_invite_preview_payload(public.safety_circle_members, text, boolean, boolean) from anon;
revoke all on function public._circle_invite_preview_payload(public.safety_circle_members, text, boolean, boolean) from authenticated;

-- ---------------------------------------------------------------------------
-- lookup_circle_invite — same anon status-only contract; shared status helper
-- ---------------------------------------------------------------------------

create or replace function public.lookup_circle_invite(token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  raw text := trim(coalesce(token, ''));
  m public.safety_circle_members%rowtype;
begin
  if char_length(raw) = 0 then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null
    );
  end if;

  select *
    into m
    from public.safety_circle_members
   where invite_token = raw;

  if not found then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null
    );
  end if;

  return jsonb_build_object(
    'status', public._circle_invite_lookup_status(m),
    'invite_expires_at', m.invite_expires_at
  );
end;
$$;

comment on function public.lookup_circle_invite(text) is
  'SCRUM-27: Token preview. Returns status pending|expired|consumed|canceled|not_found and invite_expires_at. No profile, phone, or other member fields. Does not activate membership.';

revoke all on function public.lookup_circle_invite(text) from public;
grant execute on function public.lookup_circle_invite(text) to anon;
grant execute on function public.lookup_circle_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- preview_circle_invite — authenticated; claims pending tokens
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
   where invite_token = raw
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
         where id = m.id
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
  'SCRUM-28: Authenticated invite preview (owner_name + invited_at). Claims pending tokens (sets user_id, keeps pending). Does not consume. No emergency/profile fields.';

-- ---------------------------------------------------------------------------
-- accept_circle_invite
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
   where invite_token = raw
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
     where id = m.id
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
  'SCRUM-28: Pending + recipient + location_sharing_enabled only. Sets user_id, active, invite_consumed_at. Token single-use. Does not send push/SMS/email.';

-- ---------------------------------------------------------------------------
-- decline_circle_invite
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
   where invite_token = raw
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
     where id = m.id
     returning * into m;
  exception
    when unique_violation then
      -- Still decline; do not attach user_id if another row already has it.
      update public.safety_circle_members
         set status = 'declined',
             invite_canceled_at = now(),
             invite_consumed_at = null,
             updated_at = now()
       where id = m.id
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
  'SCRUM-28: Pending only. Sets declined + invite_canceled_at. Does not grant circle access or consume-as-accept. Location sharing not required. No SMS/push/email.';

-- ---------------------------------------------------------------------------
-- list_my_circle_invites
-- ---------------------------------------------------------------------------

create or replace function public.list_my_circle_invites()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'list_my_circle_invites';
  uid uuid;
  auth_phone text;
  m public.safety_circle_members%rowtype;
  st text;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  for m in
    select scm.*
      from public.safety_circle_members scm
     where scm.role = 'member'
       and scm.status = 'pending'
       and (
         scm.user_id = uid
         or (
           scm.user_id is null
           and scm.phone is not null
           and auth_phone is not null
           and scm.phone = auth_phone
         )
       )
     for update
  loop
    st := public._circle_invite_lookup_status(m);
    if st <> 'pending' then
      continue;
    end if;
    if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
      continue;
    end if;
    if public._circle_has_active_membership(m.circle_id, uid, m.id) then
      continue;
    end if;
    if m.user_id is null then
      begin
        update public.safety_circle_members
           set user_id = uid,
               updated_at = now()
         where id = m.id;
      exception
        when unique_violation then
          null;
      end;
    end if;
  end loop;

  return (
    select coalesce(
      jsonb_agg(payload order by (payload->>'invited_at') desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
               'member_id', scm.id,
               'circle_id', scm.circle_id,
               'status', public._circle_invite_lookup_status(scm),
               'owner_name', public._circle_owner_display_name(scm.circle_id),
               'invited_at', scm.invited_at,
               'invite_expires_at', scm.invite_expires_at,
               'invite_token', case
                 when public._circle_invite_lookup_status(scm) = 'pending'
                 then scm.invite_token
                 else null
               end
             ) as payload
        from public.safety_circle_members scm
       where scm.role = 'member'
         and (
           scm.user_id = uid
           or (
             scm.user_id is null
             and scm.phone is not null
             and auth_phone is not null
             and scm.phone = auth_phone
           )
         )
         and public._circle_invite_lookup_status(scm) in (
           'pending', 'expired', 'canceled'
         )
    ) listed
  );
end;
$$;

comment on function public.list_my_circle_invites() is
  'SCRUM-28: Pending/expired/declined invites this user may see (phone match or claimed user_id). Claims pending phone rows. No other members, emergency_*, or medical. Token only while pending.';

-- ---------------------------------------------------------------------------
-- list_my_joined_circles
-- ---------------------------------------------------------------------------

create or replace function public.list_my_joined_circles()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  prefix constant text := 'list_my_joined_circles';
  uid uuid;
begin
  uid := public._require_auth_uid(prefix);

  return (
    select coalesce(
      jsonb_agg(payload order by (payload->>'joined_at') desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
               'circle_id', c.id,
               'name', c.name,
               'role', scm.role,
               'member_id', scm.id,
               'status', scm.status,
               'owner_name', public._circle_owner_display_name(c.id),
               'joined_at', scm.updated_at
             ) as payload
        from public.safety_circle_members scm
        join public.safety_circles c on c.id = scm.circle_id
       where scm.user_id = uid
         and scm.status = 'active'
    ) listed
  );
end;
$$;

comment on function public.list_my_joined_circles() is
  'SCRUM-28: Circles where the caller is an active member (owned and joined). No other members, emergency_*, medical, or owner profiles.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.preview_circle_invite(text) from public;
revoke all on function public.preview_circle_invite(text) from anon;
grant execute on function public.preview_circle_invite(text) to authenticated;

revoke all on function public.accept_circle_invite(text) from public;
revoke all on function public.accept_circle_invite(text) from anon;
grant execute on function public.accept_circle_invite(text) to authenticated;

revoke all on function public.decline_circle_invite(text) from public;
revoke all on function public.decline_circle_invite(text) from anon;
grant execute on function public.decline_circle_invite(text) to authenticated;

revoke all on function public.list_my_circle_invites() from public;
revoke all on function public.list_my_circle_invites() from anon;
grant execute on function public.list_my_circle_invites() to authenticated;

revoke all on function public.list_my_joined_circles() from public;
revoke all on function public.list_my_joined_circles() from anon;
grant execute on function public.list_my_joined_circles() to authenticated;
