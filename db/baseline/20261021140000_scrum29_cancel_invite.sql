-- SCRUM-29 amendment: owner cancel of a pending invitation, and the
-- active trusted-member count on list_my_joined_circles.
-- No new table or column. Stored status stays pending | active | declined.
-- Cancel writes declined + invite_canceled_at. Lookup then returns canceled.
-- Does not delete the row, set invite_consumed_at, write profiles, or
-- create a circle. Does not change remove_circle_member or leave_safety_circle.
-- Does not send SMS, email, or push. Does not open profiles RLS.

-- ---------------------------------------------------------------------------
-- cancel_circle_invite(member_id) — owner only, pending lookup status only
-- ---------------------------------------------------------------------------

create or replace function public.cancel_circle_invite(member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'cancel_circle_invite';
  uid uuid;
  m public.safety_circle_members%rowtype;
  caller_is_owner boolean := false;
  lookup_status text;
begin
  uid := public._require_auth_uid(prefix);

  if cancel_circle_invite.member_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.id = cancel_circle_invite.member_id
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
      message = prefix || ':cannot_cancel_owner';
  end if;

  lookup_status := public._circle_invite_lookup_status(m);

  if lookup_status is distinct from 'pending' then
    if lookup_status = 'expired' then
      raise exception using
        errcode = 'P0001',
        message = prefix || ':expired';
    end if;

    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_pending';
  end if;

  update public.safety_circle_members
     set status = 'declined',
         invite_canceled_at = now()
   where public.safety_circle_members.id = m.id;

  return jsonb_build_object(
    'member_id', m.id,
    'circle_id', m.circle_id,
    'status', 'canceled',
    'owner_name', public._circle_owner_display_name(m.circle_id)
  );
end;
$$;

comment on function public.cancel_circle_invite(uuid) is
  'SCRUM-29: Owner-only. Pending lookup status only. Sets declined and invite_canceled_at so the token looks up as canceled and the slot is released. Does not set invite_consumed_at, delete the row, write profiles, or send SMS/email/push.';

revoke all on function public.cancel_circle_invite(uuid) from public;
revoke all on function public.cancel_circle_invite(uuid) from anon;
grant execute on function public.cancel_circle_invite(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- list_my_joined_circles — same keys, plus active_member_count
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
               'joined_at', scm.updated_at,
               'active_member_count', (
                 select count(*)::integer
                   from public.safety_circle_members active_members
                  where active_members.circle_id = c.id
                    and active_members.role = 'member'
                    and active_members.status = 'active'
               )
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
  'SCRUM-28 / SCRUM-29: Circles where the caller is an active member (owned and joined). active_member_count is role member and status active on that circle (owner, pending, and declined excluded). No phone, email, emergency, or medical fields.';

revoke all on function public.list_my_joined_circles() from public;
revoke all on function public.list_my_joined_circles() from anon;
grant execute on function public.list_my_joined_circles() to authenticated;
