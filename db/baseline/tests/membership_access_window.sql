-- Rule 54 / fix #9 membership access window checks. Run as one script against
-- the hosted database. All writes stay inside this DO block. The block ends
-- by raising membership_access_window_ok so PostgreSQL rolls the test rows
-- back. A different error is a failed assert.
--
-- Covers: activated_at trigger (pending null, set on activation, owner set,
-- client cannot backdate, declined null); a member who joined after an
-- incident started cannot see it via incidents RLS, list_responder_incidents,
-- get_incident_details, incident_events, incident_delivery_counts,
-- acknowledge_incident, or own incident_deliveries row; an incident created
-- after joining is visible; a member added while an incident is ongoing does
-- not see it and got no delivery; removed and left members see nothing;
-- resident still sees own; pending user and outsider see nothing.

do $window$
declare
  resident uuid := gen_random_uuid();
  early uuid := gen_random_uuid();    -- joined 2 days ago
  member uuid := gen_random_uuid();   -- joins now (pending -> active)
  removed uuid := gen_random_uuid();  -- active, later removed by owner
  joiner uuid := gen_random_uuid();   -- joins while incident B is ongoing
  pending_user uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  cid uuid := gen_random_uuid();
  tag text := replace(gen_random_uuid()::text, '-', '');
  member_row uuid;
  removed_row uuid;
  pending_row uuid;
  inc jsonb;
  listed jsonb;
  details jsonb;
  counts jsonb;
  a_id uuid;   -- before the member joined
  b_id uuid;   -- after the member joined
  n integer;
  ts timestamptz;
begin
  -- Shape checks.
  if (select pg_get_expr(p.polqual, p.polrelid)
        from pg_policy p
       where p.polrelid = 'public.incidents'::regclass
         and p.polname = 'incidents_select_active_member')
     not ilike '%_is_active_circle_member_since%' then
    raise exception 'incidents_select_active_member does not use _is_active_circle_member_since';
  end if;

  if (select pg_get_expr(p.polqual, p.polrelid)
        from pg_policy p
       where p.polrelid = 'public.incidents'::regclass
         and p.polname = 'incidents_select_active_member')
     ilike '%safety_circle_members%' then
    raise exception 'incidents_select_active_member has a raw members subquery (RLS recursion)';
  end if;

  -- Fixtures (as the migration role).
  insert into auth.users (id, email, email_confirmed_at)
  values
    (resident, 'w54r' || tag || '@atlas.test', now()),
    (early, 'w54e' || tag || '@atlas.test', now()),
    (member, 'w54m' || tag || '@atlas.test', now()),
    (removed, 'w54x' || tag || '@atlas.test', now()),
    (joiner, 'w54j' || tag || '@atlas.test', now()),
    (pending_user, 'w54p' || tag || '@atlas.test', now()),
    (outsider, 'w54o' || tag || '@atlas.test', now());

  insert into public.profiles (id, full_name, date_of_birth, profile_setup_completed_at)
  values
    (resident, 'Resident Window', date '1990-01-01', now()),
    (early, 'Early Window', date '1991-01-01', now()),
    (member, 'Member Window', date '1991-02-01', now()),
    (removed, 'Removed Window', date '1991-03-01', now()),
    (joiner, 'Joiner Window', date '1991-04-01', now()),
    (pending_user, 'Pending Window', date '1992-01-01', now()),
    (outsider, 'Outsider Window', date '1993-01-01', now());

  insert into public.safety_circles (id, owner_id, name)
  values (cid, resident, 'My Safety Circle');

  insert into public.safety_circle_members (circle_id, role, status, display_name, user_id)
  values (cid, 'owner', 'active', 'Resident Window', resident);

  if (select activated_at from public.safety_circle_members
       where circle_id = cid and role = 'owner') is null then
    raise exception 'owner row has no activated_at';
  end if;

  -- Trusted maintenance path may set a past activation (backfill-style).
  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id, invite_consumed_at, activated_at
  )
  values (
    cid, 'member', 'active', 'Early Window', early,
    now() - interval '2 days', now() - interval '2 days'
  );

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id, invite_consumed_at
  )
  values (cid, 'member', 'active', 'Removed Window', removed, now())
  returning id into removed_row;

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid, 'member', 'pending', 'Member Window',
    public.new_circle_invite_token(), now() + interval '7 days'
  )
  returning id into member_row;

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid, 'member', 'pending', 'Pending Window',
    public.new_circle_invite_token(), now() + interval '7 days'
  )
  returning id into pending_row;

  if (select activated_at from public.safety_circle_members where id = member_row) is not null then
    raise exception 'pending row has activated_at';
  end if;

  -- Incident A: submitted, closed, and dated 1 day ago (before member joins).
  perform set_config('request.jwt.claim.sub', resident::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', resident, 'role', 'authenticated')::text, true);

  inc := public.submit_emergency_alert('medical');
  a_id := (inc->>'id')::uuid;
  perform public.mark_incident_safe(a_id);

  update public.incidents
     set activated_at = now() - interval '1 day',
         sent_at = now() - interval '1 day'
   where id = a_id;

  -- Member accepts now (same write accept_circle_invite does).
  update public.safety_circle_members
     set user_id = member,
         status = 'active',
         invite_consumed_at = now(),
         invite_token = null
   where id = member_row;

  select activated_at into ts from public.safety_circle_members where id = member_row;
  if ts is distinct from now() then
    raise exception 'activation did not stamp now(): %', ts;
  end if;

  -- Incident B: started after the member joined.
  inc := public.submit_emergency_alert('fire');
  b_id := (inc->>'id')::uuid;

  select count(*) into n
    from public.incident_deliveries
   where incident_id = b_id;
  if n <> 3 then
    raise exception 'B should deliver to early, member, removed: %', n;
  end if;

  -- Joiner added while B is ongoing (one minute later).
  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id, invite_consumed_at, activated_at
  )
  values (
    cid, 'member', 'active', 'Joiner Window', joiner,
    now() + interval '1 minute', now() + interval '1 minute'
  );

  -- A stray delivery row for the joiner must still not open B.
  insert into public.incident_deliveries (incident_id, member_id, member_user_id)
  select b_id, m.id, joiner
    from public.safety_circle_members m
   where m.circle_id = cid and m.user_id = joiner;

  -- ------------------------------------------------------------------------
  -- As the authenticated role.
  -- ------------------------------------------------------------------------
  execute 'set local role authenticated';

  -- Owner cannot backdate a member's activation.
  update public.safety_circle_members
     set activated_at = now() - interval '10 days'
   where id = member_row;

  select activated_at into ts from public.safety_circle_members where id = member_row;
  if ts is distinct from now() then
    raise exception 'owner backdated activated_at: %', ts;
  end if;

  -- Resident still sees both own incidents.
  select count(*) into n from public.incidents where id in (a_id, b_id);
  if n <> 2 then
    raise exception 'resident sees % own incidents', n;
  end if;

  select count(*) into n
    from jsonb_array_elements(public.list_my_recent_incidents(5)) e
   where (e->>'id')::uuid in (a_id, b_id);
  if n <> 2 then
    raise exception 'resident recent list has % of own incidents', n;
  end if;

  select count(*) into n from public.incident_events where incident_id = a_id;
  if n = 0 then
    raise exception 'resident sees no events on A';
  end if;

  -- Early member (joined before both) sees both.
  perform set_config('request.jwt.claim.sub', early::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', early, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incidents where id in (a_id, b_id);
  if n <> 2 then
    raise exception 'early member sees % incidents', n;
  end if;

  -- Member who joined after A: B only.
  perform set_config('request.jwt.claim.sub', member::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', member, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incidents where id = a_id;
  if n <> 0 then
    raise exception 'late member sees pre-join incident A via RLS';
  end if;

  select count(*) into n from public.incidents where id = b_id;
  if n <> 1 then
    raise exception 'member cannot see post-join incident B via RLS';
  end if;

  listed := public.list_responder_incidents();
  if exists (select 1 from jsonb_array_elements(listed) e where (e->>'id')::uuid = a_id) then
    raise exception 'list_responder_incidents leaks A: %', listed;
  end if;
  if not exists (select 1 from jsonb_array_elements(listed) e where (e->>'id')::uuid = b_id) then
    raise exception 'list_responder_incidents misses B: %', listed;
  end if;

  begin
    details := public.get_incident_details(a_id);
    raise exception 'details leak A: %', details;
  exception
    when others then
      if sqlerrm not like 'get_incident_details:not_found%' then
        raise exception 'details A got %', sqlerrm;
      end if;
  end;

  details := public.get_incident_details(b_id);
  if (details->>'id')::uuid is distinct from b_id then
    raise exception 'details B wrong: %', details;
  end if;

  select count(*) into n from public.incident_events where incident_id = a_id;
  if n <> 0 then
    raise exception 'late member sees % events on A', n;
  end if;

  select count(*) into n from public.incident_events where incident_id = b_id;
  if n = 0 then
    raise exception 'member sees no events on B';
  end if;

  counts := public.incident_delivery_counts(b_id);
  if (counts->>'delivered_count')::int < 3 then
    raise exception 'counts B wrong: %', counts;
  end if;

  counts := public.acknowledge_incident(b_id);
  if (counts->>'acknowledged_count')::int <> 1 then
    raise exception 'ack B wrong: %', counts;
  end if;

  select count(*) into n from public.incident_deliveries where member_user_id = member;
  if n <> 1 then
    raise exception 'member sees % own delivery rows', n;
  end if;

  -- Joiner (added while B ongoing): nothing.
  perform set_config('request.jwt.claim.sub', joiner::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', joiner, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incidents where id in (a_id, b_id);
  if n <> 0 then
    raise exception 'joiner sees % incidents', n;
  end if;

  if jsonb_array_length(public.list_responder_incidents()) <> 0 then
    raise exception 'joiner list not empty';
  end if;

  select count(*) into n from public.incident_events where incident_id in (a_id, b_id);
  if n <> 0 then
    raise exception 'joiner sees % events', n;
  end if;

  select count(*) into n from public.incident_deliveries where member_user_id = joiner;
  if n <> 0 then
    raise exception 'joiner sees own stray delivery row';
  end if;

  begin
    details := public.get_incident_details(b_id);
    raise exception 'details leak B to joiner: %', details;
  exception
    when others then
      if sqlerrm not like 'get_incident_details:not_found%' then
        raise exception 'joiner details B got %', sqlerrm;
      end if;
  end;

  begin
    counts := public.incident_delivery_counts(b_id);
    raise exception 'counts leak B to joiner: %', counts;
  exception
    when others then
      if sqlerrm not like 'incident_delivery_counts:not_found%' then
        raise exception 'joiner counts B got %', sqlerrm;
      end if;
  end;

  begin
    counts := public.acknowledge_incident(b_id);
    raise exception 'joiner acked B: %', counts;
  exception
    when others then
      if sqlerrm not like 'acknowledge_incident:not_found%' then
        raise exception 'joiner ack B got %', sqlerrm;
      end if;
  end;

  -- Pending user and outsider: nothing.
  perform set_config('request.jwt.claim.sub', pending_user::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pending_user, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incidents where id in (a_id, b_id);
  if n <> 0 then
    raise exception 'pending user sees % incidents', n;
  end if;

  perform set_config('request.jwt.claim.sub', outsider::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', outsider, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incidents where id in (a_id, b_id);
  if n <> 0 then
    raise exception 'outsider sees % incidents', n;
  end if;

  select count(*) into n from public.incident_events where incident_id in (a_id, b_id);
  if n <> 0 then
    raise exception 'outsider sees % events', n;
  end if;

  if jsonb_array_length(public.list_responder_incidents()) <> 0 then
    raise exception 'outsider list not empty';
  end if;

  begin
    details := public.get_incident_details(b_id);
    raise exception 'details leak B to outsider: %', details;
  exception
    when others then
      if sqlerrm not like 'get_incident_details:not_found%' then
        raise exception 'outsider details B got %', sqlerrm;
      end if;
  end;

  -- Removed member: sees B before removal, nothing after.
  perform set_config('request.jwt.claim.sub', removed::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', removed, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incidents where id = b_id;
  if n <> 1 then
    raise exception 'removed-to-be member cannot see B before removal';
  end if;

  perform set_config('request.jwt.claim.sub', resident::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', resident, 'role', 'authenticated')::text, true);
  perform public.remove_circle_member(removed_row);

  perform set_config('request.jwt.claim.sub', removed::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', removed, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incidents where id in (a_id, b_id);
  if n <> 0 then
    raise exception 'removed member sees % incidents', n;
  end if;

  select count(*) into n from public.incident_events where incident_id in (a_id, b_id);
  if n <> 0 then
    raise exception 'removed member sees % events', n;
  end if;

  if jsonb_array_length(public.list_responder_incidents()) <> 0 then
    raise exception 'removed member list not empty';
  end if;

  begin
    details := public.get_incident_details(b_id);
    raise exception 'details leak B to removed member: %', details;
  exception
    when others then
      if sqlerrm not like 'get_incident_details:not_found%' then
        raise exception 'removed details B got %', sqlerrm;
      end if;
  end;

  -- Member leaves: nothing after.
  perform set_config('request.jwt.claim.sub', member::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.leave_safety_circle(cid);

  select count(*) into n from public.incidents where id in (a_id, b_id);
  if n <> 0 then
    raise exception 'left member sees % incidents', n;
  end if;

  select count(*) into n from public.incident_events where incident_id in (a_id, b_id);
  if n <> 0 then
    raise exception 'left member sees % events', n;
  end if;

  if jsonb_array_length(public.list_responder_incidents()) <> 0 then
    raise exception 'left member list not empty';
  end if;

  begin
    counts := public.acknowledge_incident(b_id);
    raise exception 'left member acked B: %', counts;
  exception
    when others then
      if sqlerrm not like 'acknowledge_incident:not_found%' then
        raise exception 'left member ack B got %', sqlerrm;
      end if;
  end;

  execute 'reset role';

  -- Declined rows carry no activation time.
  update public.safety_circle_members
     set status = 'declined'
   where id = pending_row;

  if (select activated_at from public.safety_circle_members where id = pending_row) is not null then
    raise exception 'declined row has activated_at';
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'membership_access_window_ok';
end
$window$;
