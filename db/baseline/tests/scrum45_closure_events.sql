-- SCRUM-41 / 45 closure + incident_events checks. Run as one script against
-- the hosted database. All writes stay inside this DO block. The block ends
-- by raising scrum45_closure_events_ok so PostgreSQL rolls the test rows
-- back. A different error is a failed assert.
--
-- Covers: mark safe writes safe_recorded / incident_closed /
-- location_sharing_ended / closure_notified exactly once; idempotent retry
-- adds nothing and keeps timestamps; location_sharing_ended_at set; late
-- attach after close is not_open and does not reopen; renotify after close
-- is not_open; events are not client-writable; RLS: resident and active
-- member see events, pending member and outsider see none; member SELECT of
-- the closed incident still works; a new submit after close is a new
-- incident.

do $scrum45$
declare
  resident uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  member2 uuid := gen_random_uuid();
  pending_user uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  cid uuid := gen_random_uuid();
  tag text := replace(gen_random_uuid()::text, '-', '');
  inc jsonb;
  safe1 jsonb;
  safe2 jsonb;
  located jsonb;
  details jsonb;
  ev jsonb;
  iid uuid;
  n integer;
  saved_resolved timestamptz;
  saved_ended timestamptz;
  saved_lat double precision;
begin
  if has_table_privilege('authenticated', 'public.incident_events', 'insert')
     or has_table_privilege('authenticated', 'public.incident_events', 'update')
     or has_table_privilege('authenticated', 'public.incident_events', 'delete')
     or not has_table_privilege('authenticated', 'public.incident_events', 'select')
     or has_table_privilege('anon', 'public.incident_events', 'select')
  then
    raise exception 'incident_events grants are not select-only for authenticated';
  end if;

  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.incident_events'::regclass) then
    raise exception 'incident_events RLS disabled';
  end if;

  select count(*) into n
    from pg_policies
   where schemaname = 'public' and tablename = 'incident_events';
  if n <> 1 then
    raise exception 'incident_events should have exactly one (select) policy: %', n;
  end if;

  if (select pg_get_expr(p.polqual, p.polrelid)
        from pg_policy p
       where p.polrelid = 'public.incidents'::regclass
         and p.polname = 'incidents_select_active_member')
     not ilike '%_is_active_circle_member%' then
    raise exception 'incidents_select_active_member lost _is_active_circle_member';
  end if;

  -- Fixtures.
  insert into auth.users (id, email, email_confirmed_at)
  values
    (resident, 's45r' || tag || '@atlas.test', now()),
    (member, 's45m' || tag || '@atlas.test', now()),
    (member2, 's45n' || tag || '@atlas.test', now()),
    (pending_user, 's45p' || tag || '@atlas.test', now()),
    (outsider, 's45o' || tag || '@atlas.test', now());

  insert into public.profiles (id, full_name, date_of_birth, profile_setup_completed_at)
  values
    (resident, 'Resident Safe', date '1990-01-01', now()),
    (member, 'Member Safe', date '1991-01-01', now()),
    (member2, 'Member Two', date '1991-02-01', now()),
    (pending_user, 'Pending Safe', date '1992-01-01', now()),
    (outsider, 'Outsider Safe', date '1993-01-01', now());

  insert into public.safety_circles (id, owner_id, name)
  values (cid, resident, 'My Safety Circle');

  insert into public.safety_circle_members (circle_id, role, status, display_name, user_id)
  values (cid, 'owner', 'active', 'Resident Safe', resident);

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id, invite_consumed_at
  )
  values
    (cid, 'member', 'active', 'Member Safe', member, now()),
    (cid, 'member', 'active', 'Member Two', member2, now());

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid, 'member', 'pending', 'Pending Safe',
    public.new_circle_invite_token(), now() + interval '7 days'
  );

  -- Resident submits + live ping.
  perform set_config('request.jwt.claim.sub', resident::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', resident, 'role', 'authenticated')::text, true);

  inc := public.submit_emergency_alert('burglary');
  iid := (inc->>'id')::uuid;

  located := public.attach_incident_location(
    iid, 'current', 9.03, 38.74, 12.5, now()
  );
  if (located->>'location_lat')::double precision is distinct from 9.03 then
    raise exception 'live attach failed: %', located;
  end if;
  saved_lat := 9.03;

  -- Mark safe.
  safe1 := public.mark_incident_safe(iid);
  if safe1->>'status' is distinct from 'resolved'
     or safe1->>'resolved_reason' is distinct from 'safe'
     or safe1->>'resolved_at' is null
     or safe1->>'location_sharing_ended_at' is null
     or (safe1->>'auto_closed')::boolean is distinct from false
     or (safe1->>'delivered_count')::int is distinct from 2
     or safe1->>'emergency_type' is distinct from 'burglary'
  then
    raise exception 'mark safe payload failed: %', safe1;
  end if;
  saved_resolved := (safe1->>'resolved_at')::timestamptz;
  saved_ended := (safe1->>'location_sharing_ended_at')::timestamptz;

  select jsonb_object_agg(e.event_type, e.cnt) into ev
    from (
      select event_type, count(*) as cnt
        from public.incident_events
       where incident_id = iid
       group by event_type
    ) e;
  if ev is distinct from jsonb_build_object(
       'alert_sent', 1,
       'location_sharing_started', 1,
       'safe_recorded', 1,
       'incident_closed', 1,
       'location_sharing_ended', 1,
       'closure_notified', 1
     ) then
    raise exception 'events after mark safe wrong: %', ev;
  end if;

  select e.detail into ev
    from public.incident_events e
   where e.incident_id = iid and e.event_type = 'closure_notified';
  if (ev->>'recipient_count')::int is distinct from 2
     or jsonb_array_length(ev->'recipient_ids') <> 2
     or ev->'recipient_ids' @> jsonb_build_array(resident::text)
  then
    raise exception 'closure_notified detail wrong: %', ev;
  end if;

  if not exists (
    select 1 from public.incident_events e
     where e.incident_id = iid
       and e.event_type = 'incident_closed'
       and e.detail->>'resolved_reason' = 'safe'
       and e.actor_id = resident
  ) then
    raise exception 'incident_closed detail wrong';
  end if;

  -- Idempotent retry: same timestamps, no new events.
  safe2 := public.mark_incident_safe(iid);
  if (safe2->>'resolved_at')::timestamptz is distinct from saved_resolved
     or (safe2->>'location_sharing_ended_at')::timestamptz is distinct from saved_ended
     or safe2->>'status' is distinct from 'resolved' then
    raise exception 'mark safe retry changed the row: %', safe2;
  end if;

  select count(*) into n from public.incident_events where incident_id = iid;
  if n <> 6 then
    raise exception 'mark safe retry added events: %', n;
  end if;

  -- Late ping after close: rejected, no write, no reopen.
  begin
    perform public.attach_incident_location(
      iid, 'current', 1.0, 1.0, 5.0, now() + interval '1 minute'
    );
    raise exception 'attach after close did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'attach_incident_location:not_open%' then
        raise exception 'attach after close got %', sqlerrm;
      end if;
  end;

  begin
    perform public.attach_incident_location(iid, 'unavailable');
    raise exception 'unavailable attach after close did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'attach_incident_location:not_open%' then
        raise exception 'unavailable attach after close got %', sqlerrm;
      end if;
  end;

  if exists (
    select 1 from public.incidents i
     where i.id = iid
       and (i.status <> 'resolved' or i.location_lat is distinct from saved_lat)
  ) then
    raise exception 'late ping reopened or rewrote the incident';
  end if;

  begin
    perform public.renotify_emergency_alert(iid);
    raise exception 'renotify after close did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'renotify_emergency_alert:not_open%' then
        raise exception 'renotify after close got %', sqlerrm;
      end if;
  end;

  -- RLS visibility (as the authenticated role).
  execute 'set local role authenticated';

  select count(*) into n from public.incident_events where incident_id = iid;
  if n <> 6 then
    raise exception 'resident sees % events', n;
  end if;

  perform set_config('request.jwt.claim.sub', member::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', member, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incident_events where incident_id = iid;
  if n <> 6 then
    raise exception 'active member sees % events', n;
  end if;

  select count(*) into n from public.incidents where id = iid and status = 'resolved';
  if n <> 1 then
    raise exception 'active member cannot see the closed incident';
  end if;

  begin
    insert into public.incident_events (incident_id, event_type, actor_id)
    values (iid, 'renotified', member);
    raise exception 'member inserted an event';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.incidents set status = 'active' where id = iid;
    raise exception 'member updated an incident';
  exception
    when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claim.sub', pending_user::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pending_user, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incident_events where incident_id = iid;
  if n <> 0 then
    raise exception 'pending user sees % events', n;
  end if;

  perform set_config('request.jwt.claim.sub', outsider::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', outsider, 'role', 'authenticated')::text, true);

  select count(*) into n from public.incident_events where incident_id = iid;
  if n <> 0 then
    raise exception 'outsider sees % events', n;
  end if;

  select count(*) into n from public.incidents where id = iid;
  if n <> 0 then
    raise exception 'outsider sees the incident';
  end if;

  -- Resident cannot write incidents directly (no reopen path).
  perform set_config('request.jwt.claim.sub', resident::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', resident, 'role', 'authenticated')::text, true);

  begin
    update public.incidents set status = 'active' where id = iid;
    raise exception 'resident updated an incident directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.incidents (resident_id, status) values (resident, 'activating');
    raise exception 'resident inserted an incident directly';
  exception
    when insufficient_privilege then null;
  end;

  execute 'reset role';

  -- Member details show the ended session.
  perform set_config('request.jwt.claim.sub', member::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', member, 'role', 'authenticated')::text, true);

  details := public.get_incident_details(iid);
  if details->>'status' is distinct from 'resolved'
     or details->>'location_sharing_ended_at' is null
     or details->>'emergency_type' is distinct from 'burglary' then
    raise exception 'member details after close wrong: %', details;
  end if;

  -- A new submit after close is a new incident.
  perform set_config('request.jwt.claim.sub', resident::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', resident, 'role', 'authenticated')::text, true);

  inc := public.submit_emergency_alert('medical');
  if inc->>'id' = iid::text
     or inc->>'submit_outcome' is distinct from 'created'
     or inc->>'status' is distinct from 'active' then
    raise exception 'submit after close failed: %', inc;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'scrum45_closure_events_ok';
end
$scrum45$;
