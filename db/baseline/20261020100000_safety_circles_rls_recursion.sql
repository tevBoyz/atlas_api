-- Break RLS 42P17 on safety_circles SELECT.
-- safety_circles_select_active_member existed (SCRUM-28) as
--   exists (select 1 from safety_circle_members ...)
-- safety_circle_members_select_owner exists (SCRUM-80) as
--   exists (select 1 from safety_circles where owner_id = auth.uid())
-- Postgres ORs SELECT policies and evaluates both → infinite recursion.
-- incidents_select_active_member (SCRUM-36) used the same members subquery.
-- Helper is SECURITY DEFINER so it reads members without RLS.
-- Does not change safety_circles_select_own. Does not delete member rows.

-- ---------------------------------------------------------------------------
-- Internal helper (clients do not call this; policies evaluate as invoker)
-- ---------------------------------------------------------------------------

create or replace function public._is_active_circle_member(circle_id uuid, uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.safety_circle_members m
    where m.circle_id = _is_active_circle_member.circle_id
      and m.user_id = _is_active_circle_member.uid
      and m.status = 'active'
  );
$$;

comment on function public._is_active_circle_member(uuid, uuid) is
  'Internal: true when uid has an active safety_circle_members row on circle_id. SECURITY DEFINER so RLS cannot recurse. Used by safety_circles_select_active_member and incidents_select_active_member.';

revoke all on function public._is_active_circle_member(uuid, uuid) from public;
revoke all on function public._is_active_circle_member(uuid, uuid) from anon;
revoke all on function public._is_active_circle_member(uuid, uuid) from authenticated;

-- RLS USING runs as the invoking role, so authenticated needs EXECUTE.
-- anon stays revoked. Do not grant to PUBLIC.
grant execute on function public._is_active_circle_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- safety_circles: member SELECT via helper (owner policy unchanged)
-- ---------------------------------------------------------------------------

drop policy if exists "safety_circles_select_active_member" on public.safety_circles;
create policy "safety_circles_select_active_member"
  on public.safety_circles
  for select
  to authenticated
  using (public._is_active_circle_member(safety_circles.id, auth.uid()));

comment on policy "safety_circles_select_active_member" on public.safety_circles is
  'SCRUM-28: Active members can SELECT the joined circle. Uses _is_active_circle_member so members_select_owner cannot recurse. Pending/declined cannot. Does not grant profiles.';

-- ---------------------------------------------------------------------------
-- incidents: same helper (prevents the same loop when members → circles)
-- ---------------------------------------------------------------------------

drop policy if exists "incidents_select_active_member" on public.incidents;
create policy "incidents_select_active_member"
  on public.incidents
  for select
  to authenticated
  using (
    circle_id is not null
    and public._is_active_circle_member(incidents.circle_id, auth.uid())
  );

comment on policy "incidents_select_active_member" on public.incidents is
  'SCRUM-36 / 48: Active circle members can SELECT. Uses _is_active_circle_member (no RLS loop). Pending/declined cannot. Does not notify (43).';
