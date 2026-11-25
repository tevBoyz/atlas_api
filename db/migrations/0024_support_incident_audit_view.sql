-- SCRUM-74 (incident audit trail), decision D75: support and compliance access to an incident's
-- audit trail.
--
-- `public.support_incident_audit`: a READ-ONLY view of every `audit_log` row about an incident
-- (`target_type = 'incident'`), in time order, with the incident's resident (id and name), circle
-- id, emergency type and status. Support reads it in the Supabase SQL editor as `postgres`
-- (runbook §2.8); there is no endpoint and no admin role.
--
-- Columns: ids, names, the action, its time and the audit `detail` (which never holds medical or
-- shared fields, tokens, phone numbers or coordinates, API-100-14 AC4). Never the incident's
-- coordinates, notes, share payloads, phone numbers or tokens, and not the client IP of the audit
-- row. LEFT JOINs: an audit row outlives its incident and profile (0003 has no foreign keys on
-- purpose), and stays visible with null incident columns.
--
-- Read-only: a view over a join is not updatable, `audit_log` refuses UPDATE / DELETE / TRUNCATE
-- (0003), and `security_invoker` makes the reader's own privileges apply to the underlying tables.
-- The Supabase API roles get no privileges on it (Supabase grants new `public` objects to `anon` /
-- `authenticated` by default), the same lockdown as 0001 / 0003.
--
-- Additive only (AGENTS.md rule 4): one new view. Re-runnable on a fresh database after the
-- baseline.

create or replace view public.support_incident_audit
  with (security_invoker = true)
as
select a.target_id as incident_id,
       a.id as audit_id,
       a.occurred_at,
       a.action,
       a.actor_user_id,
       a.actor_session_id,
       a.request_id,
       a.detail,
       i.resident_id,
       nullif(btrim(p.full_name), '') as resident_name,
       i.circle_id,
       i.emergency_type,
       i.status as incident_status
  from public.audit_log a
  left join public.incidents i on i.id = a.target_id
  left join public.profiles p on p.id = i.resident_id
 where a.target_type = 'incident'
 order by a.occurred_at, a.id;

comment on view public.support_incident_audit is
  'SCRUM-74 (D75): read-only support view of the audit trail of incidents (audit_log rows with target_type incident, time order) with the incident''s resident id and name, circle id, emergency type and status. Ids and names only: no coordinates, notes, share payloads, phone numbers, tokens or client IP. For the SQL editor as postgres; no Supabase API role may read it.';

revoke all on table public.support_incident_audit from public;
revoke all on table public.support_incident_audit from anon;
revoke all on table public.support_incident_audit from authenticated;
