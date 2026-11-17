-- SCRUM-28 amendment: Accept does not read or write profiles and does not
-- require location_sharing_enabled. It does not turn on continuous location.
-- Owner accept is own_circle. Activation that would pass 5 trusted members
-- (owner excluded; declined excluded) is circle_full and writes nothing.
-- A pending row already occupies its slot, so accept at exactly 5 succeeds.
-- Preview returns already_member / circle_full / own_circle instead of raising
-- already_member. Non-owners listing members see active rows only.
-- No SMS, email, push, or new table. RPC names and token arguments stay.

-- ---------------------------------------------------------------------------
-- Slots this accept would occupy. Excludes this row, the owner, and declined.
-- used_after = other active members + other pending invites + 1.
-- ---------------------------------------------------------------------------

create or replace function public._circle_accept_used_after(
  p_circle_id uuid,
  p_member_id uuid
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (
    count(*) filter (
      where scm.role = 'member'
        and scm.status = 'active'
        and scm.id is distinct from p_member_id
    )
    + count(*) filter (
      where scm.role = 'member'
        and scm.status = 'pending'
        and scm.id is distinct from p_member_id
    )
    + 1
  )::integer
  from public.safety_circle_members scm
  where scm.circle_id = p_circle_id;
$$;

comment on function public._circle_accept_used_after(uuid, uuid) is
  'SCRUM-28: Trusted slots after activating p_member_id. Owner and declined rows are excluded. The row itself is excluded, then +1. Internal.';

revoke all on function public._circle_accept_used_after(uuid, uuid) from public;
revoke all on function public._circle_accept_used_after(uuid, uuid) from anon;
revoke all on function public._circle_accept_used_after(uuid, uuid) from authenticated;

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
  recipient_ok boolean := false;
  claimed boolean := false;
  display_status text;
  show_owner boolean := false;
  include_row boolean := false;
  circle_owner uuid;
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
      'recipient_ok', false,
      'owner_avatar_url', null
    );
  end if;

  select *
    into m
    from public.safety_circle_members scm
   where scm.invite_token = raw
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
      'recipient_ok', false,
      'owner_avatar_url', null
    );
  end if;

  st := public._circle_invite_lookup_status(m);
  recipient_ok := public._circle_invite_recipient_ok(m, uid, auth_phone);

  select sc.owner_id
    into circle_owner
    from public.safety_circles sc
   where sc.id = m.circle_id;

  if circle_owner = uid then
    -- Owner preview never claims and never activates.
    display_status := 'own_circle';
    show_owner := true;
    include_row := true;
    claimed := m.user_id = uid;
  elsif m.status = 'active' and m.user_id = uid then
    display_status := 'already_member';
    show_owner := true;
    include_row := true;
    claimed := true;
  elsif st = 'consumed' then
    display_status := 'consumed';
    show_owner := false;
    include_row := false;
    claimed := false;
    recipient_ok := false;
  elsif st = 'canceled' then
    display_status := 'canceled';
    show_owner := false;
    include_row := recipient_ok;
    claimed := recipient_ok and m.user_id = uid;
  elsif st = 'expired' then
    display_status := 'expired';
    show_owner := recipient_ok;
    include_row := recipient_ok;
    claimed := recipient_ok and m.user_id = uid;
  elsif public._circle_has_active_membership(m.circle_id, uid, m.id) then
    display_status := 'already_member';
    show_owner := true;
    include_row := true;
    claimed := false;
  elsif st = 'pending' and recipient_ok then
    if public._circle_accept_used_after(m.circle_id, m.id)
         > public._circle_member_limit() then
      display_status := 'circle_full';
      show_owner := true;
      include_row := true;
      if m.user_id = uid then
        claimed := true;
      elsif m.user_id is null
            and not exists (
              select 1
                from public.safety_circle_members x
               where x.circle_id = m.circle_id
                 and x.user_id = uid
                 and x.id <> m.id
            ) then
        begin
          update public.safety_circle_members
             set user_id = uid,
                 updated_at = now()
           where public.safety_circle_members.id = m.id
           returning * into m;
          claimed := true;
        exception
          when unique_violation then
            claimed := false;
        end;
      else
        claimed := false;
      end if;
    else
      display_status := 'pending';
      show_owner := true;
      include_row := true;
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
    end if;
  else
    display_status := st;
    show_owner := false;
    include_row := false;
    claimed := false;
  end if;

  return jsonb_build_object(
    'status', display_status,
    'invite_expires_at', m.invite_expires_at,
    'member_id', case when include_row then m.id else null end,
    'circle_id', case when include_row then m.circle_id else null end,
    'owner_name', case
      when show_owner then public._circle_owner_display_name(m.circle_id)
      else null
    end,
    'invited_at', case when include_row then m.invited_at else null end,
    'claimed', claimed,
    'recipient_ok', recipient_ok,
    'owner_avatar_url', case
      when show_owner then public._member_avatar_url(circle_owner)
      else null
    end
  );
end;
$$;

comment on function public.preview_circle_invite(text) is
  'SCRUM-28: Authenticated preview. Claims a still-pending intended recipient (user_id set, status stays pending) except own_circle, already_member, and circle_full when the claim would duplicate. Returns already_member, circle_full, and own_circle instead of raising already_member. owner_avatar_url only when owner_name is returned. No emergency or medical profile fields. No SMS.';

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
  cid uuid;
  m public.safety_circle_members%rowtype;
  st text;
  circle_owner uuid;
  used_after integer;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  if char_length(raw) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  -- Circle lock first, same order as the SCRUM-27 invite RPCs, so two accepts
  -- cannot both pass the capacity check.
  select scm.circle_id
    into cid
    from public.safety_circle_members scm
   where scm.invite_token = raw;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  perform 1
    from public.safety_circles sc
   where sc.id = cid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members scm
   where scm.invite_token = raw
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  -- Same token, already active for this caller: success, no second row.
  if m.status = 'active' and m.user_id = uid then
    return jsonb_build_object(
      'circle_id', m.circle_id,
      'member_id', m.id,
      'status', 'active',
      'owner_name', public._circle_owner_display_name(m.circle_id)
    );
  end if;

  st := public._circle_invite_lookup_status(m);
  perform public._reject_unless_pending(prefix, st);

  if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_recipient';
  end if;

  select sc.owner_id
    into circle_owner
    from public.safety_circles sc
   where sc.id = m.circle_id;

  if circle_owner = uid then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':own_circle';
  end if;

  if public._circle_has_active_membership(m.circle_id, uid, m.id) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':already_member';
  end if;

  used_after := public._circle_accept_used_after(m.circle_id, m.id);
  if used_after > public._circle_member_limit() then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':circle_full';
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
  'SCRUM-28: Pending + recipient. Does not read or write profiles and does not require location sharing. Owner gets own_circle. Over-capacity gets circle_full and no write. Already-active for this caller returns the same JSON. Does not create a personal circle. No SMS/push/email.';

-- ---------------------------------------------------------------------------
-- decline_circle_invite(token) — same write; add owner_name
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
    from public.safety_circle_members scm
   where scm.invite_token = raw
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
    'status', m.status,
    'owner_name', public._circle_owner_display_name(m.circle_id)
  );
end;
$$;

comment on function public.decline_circle_invite(text) is
  'SCRUM-28: Pending only. Sets declined + invite_canceled_at so the trusted-member slot is released. Does not require location sharing. Does not grant membership. No SMS/push/email.';

-- ---------------------------------------------------------------------------
-- list_circle_members(circle_id) — non-owners see active rows only
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
      from public.safety_circle_members mem
     where mem.circle_id = list_circle_members.circle_id
       and mem.user_id = uid
       and mem.status = 'active'
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
          or scm.status = 'active'
        )
    ) listed
  );
end;
$$;

comment on function public.list_circle_members(uuid) is
  'SCRUM-29 / SCRUM-28: Owner lists every status, including pending. An active non-owner lists active rows only (owner row plus active members). Non-owners do not receive phone, email, relationship, invite token, or emergency fields.';

-- ---------------------------------------------------------------------------
-- Grants (CREATE OR REPLACE keeps them; restated)
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

revoke all on function public.list_circle_members(uuid) from public;
revoke all on function public.list_circle_members(uuid) from anon;
grant execute on function public.list_circle_members(uuid) to authenticated;
