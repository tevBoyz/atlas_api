-- SCRUM-46: End Incident — RETIRED (Cancelled in Jira; merged into SCRUM-45)
-- Drops the four SCRUM-46 RPCs and their internal inactivity helpers.
-- Mark Safe (SCRUM-45, mark_incident_safe) is now the only close path.
-- Keeps the resolve columns (resolved_reason 'ended', auto_closed,
-- activity_confirmed_at) and their check constraints so historical rows
-- written by 46 stay valid and readable. No new writer sets 'ended',
-- auto_closed = true, or activity_confirmed_at.
-- No pg_cron, no Edge Function, no FCM, no Twilio.
-- Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- Drop retired client RPCs
-- ---------------------------------------------------------------------------

drop function if exists public.end_incident(uuid);
drop function if exists public.incident_inactivity_due();
drop function if exists public.confirm_incident_still_active(uuid);
drop function if exists public.auto_close_inactive_incident(uuid);

-- ---------------------------------------------------------------------------
-- Drop now-unused internal helpers (only the RPCs above called them)
-- ---------------------------------------------------------------------------

drop function if exists public._incident_inactivity_is_due(public.incidents);
drop function if exists public._incident_activity_at(public.incidents);

-- ---------------------------------------------------------------------------
-- Comments: columns stay for history only
-- ---------------------------------------------------------------------------

comment on column public.incidents.resolved_reason is
  'SCRUM-45 writes safe (only live writer). ended is legacy from retired SCRUM-46 (Cancelled) and stays valid for history. Null until resolved.';

comment on column public.incidents.auto_closed is
  'Legacy (retired SCRUM-46). true only on historical rows auto-closed by the removed 24h path. No current writer sets true. Must be false unless status is resolved.';

comment on column public.incidents.activity_confirmed_at is
  'Legacy (retired SCRUM-46) still-active stamp. No current writer. Kept so historical rows stay readable.';

comment on constraint incidents_resolved_reason_check on public.incidents is
  'SCRUM-45: resolved_reason is null, safe, or legacy ended (retired SCRUM-46 history).';

comment on column public.incidents.status is
  'activating (legacy 36) | active | cancelled (legacy 42) | resolved (45 safe; legacy 46 ended). Current writers: submit_emergency_alert (active), mark_incident_safe (resolved).';

comment on table public.incidents is
  'Emergency loop. One open incident per resident (incidents_one_open_per_resident_uidx). SCRUM-46 end / 24h auto-close is retired; mark safe (45) is the only close. Rows are never deleted. Not FCM/SMS. Not pg_cron.';
