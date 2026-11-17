-- SCRUM-29: View Safety Circle Members (list + owner remove + invitee leave)
-- SECURITY DEFINER RPCs. Does not open profiles RLS. Does not send SMS/push.
-- Does not write profiles.emergency_*. Does not add incident/SOS.
-- Hosted Supabase, no Express, no Edge Functions.

-- ---------------------------------------------------------------------------
-- Avatar public URL (avatars bucket is public; DEFINER reads avatar_path only)
-- ---------------------------------------------------------------------------

create or replace function public._avatars_public_url(object_path text)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  raw text := nullif(trim(coalesce(object_path, '')), '');
  host text;
begin
  if raw is null then
    return null;
  end if;

  if raw ~* '^https?://' then
    return raw;
  end if;

  begin
    host := nullif(
      trim(
        split_part(
          coalesce(
            current_setting('request.headers', true)::json->>'x-forwarded-host',
            current_setting('request.headers', true)::json->>'host',
            ''
          ),
          ',',
          1
        )
      ),
      ''
    );
  exception
    when others then
      host := null;
  end;

  if host is not null then
    host := split_part(host, ':', 1);
    return 'https://' || host || '/storage/v1/object/public/avatars/' || raw;
  end if;

  -- Host missing (direct SQL). Same public path Flutter prefixes with SUPABASE_URL
  -- or resolves via storage.from('avatars').getPublicUrl(object_path).
  return '/storage/v1/object/public/avatars/' || raw;
end;
$$;

comment on function public._avatars_public_url(text) is
  'SCRUM-29: Public avatars URL from object path. Internal. Does not read other profile columns.';

create or replace function public._member_avatar_url(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public._avatars_public_url(p.avatar_path)
    from public.profiles p
   where p.id = uid;
$$;

comment on function public._member_avatar_url(uuid) is
  'SCRUM-29: avatar_path only for uid. Null if no profile or no photo. Internal. Does not expose emergency_*, medical, or share flags.';

revoke all on function public._avatars_public_url(text) from public;
revoke all on function public._avatars_public_url(text) from anon;
revoke all on function public._avatars_public_url(text) from authenticated;

revoke all on function public._member_avatar_url(uuid) from public;
revoke all on function public._member_avatar_url(uuid) from anon;
revoke all on function public._member_avatar_url(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- list_circle_members — owner or active member
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

  if circle_id is null then
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
  'SCRUM-29: Owner or active member lists members of that circle. Invitees get name/role/status/avatar only. Owner also gets phone/email/relationship/invite stamps. No emergency_*, medical, share flags, or invite tokens. Pending without user_id have avatar_url null.';

-- ---------------------------------------------------------------------------
-- remove_circle_member — owner only; never the owner row; never the circle
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
   where id = member_id
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
   where id = m.id;

  -- Does not write profiles.emergency_*. Does not delete the circle.
  return jsonb_build_object(
    'member_id', m.id,
    'circle_id', m.circle_id,
    'removed', true
  );
end;
$$;

comment on function public.remove_circle_member(uuid) is
  'SCRUM-29: Owner-only. Deletes a non-owner member row (pending/active/declined). Cannot remove the owner or the circle. Does not write profiles.emergency_*. No SMS/push.';

-- ---------------------------------------------------------------------------
-- leave_safety_circle — active non-owner only
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

  if circle_id is null then
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
   where circle_id = leave_safety_circle.circle_id
     and user_id = uid
     and status = 'active'
     and role = 'member'
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  delete from public.safety_circle_members
   where id = m.id;

  return jsonb_build_object(
    'circle_id', m.circle_id,
    'member_id', m.id,
    'left', true
  );
end;
$$;

comment on function public.leave_safety_circle(uuid) is
  'SCRUM-29: Active non-owner deletes their membership row so they drop from the list and from list_my_joined_circles. Owner cannot leave. Does not delete the circle. No SMS/push.';

-- ---------------------------------------------------------------------------
-- Grants (authenticated only). No DELETE policy on the table. No profiles grants.
-- ---------------------------------------------------------------------------

revoke all on function public.list_circle_members(uuid) from public;
revoke all on function public.list_circle_members(uuid) from anon;
grant execute on function public.list_circle_members(uuid) to authenticated;

revoke all on function public.remove_circle_member(uuid) from public;
revoke all on function public.remove_circle_member(uuid) from anon;
grant execute on function public.remove_circle_member(uuid) to authenticated;

revoke all on function public.leave_safety_circle(uuid) from public;
revoke all on function public.leave_safety_circle(uuid) from anon;
grant execute on function public.leave_safety_circle(uuid) to authenticated;
