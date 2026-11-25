-- SCRUM-65 / 66 / 67 / 71 (alert delivery), decision D73.
--
-- 1. SCRUM-67: `notification_deliveries.final_at` (timestamptz, nullable): when the row reached its
--    final state. `sent` / `delivered`: the time the provider accepted it (= `sent_at`); `failed`:
--    the time the last attempt failed; `skipped`: the time it was skipped (at fan-out, or by the
--    sender). Null exactly while the row is `queued` (check `notification_deliveries_final_at_shape`).
--    Existing final rows are back-filled first: `sent_at` for accepted rows, else `updated_at` (the
--    time of their last write, which for a final row is the time it became final), so the check
--    holds for every row. A BEFORE trigger fills `final_at` (`coalesce(sent_at, now())`) when a write
--    makes a row final without it, so a build that does not know the column (a rolling deploy)
--    keeps working; this build sets it itself.
-- 2. SCRUM-71: `incident_deliveries.delivery_failed_notified_at` (timestamptz, nullable): when the
--    resident was told that this member did not receive the alert (live event
--    `incident.delivery_failed` + a push to the resident). Set at most once per member per incident
--    (decision 3: one notice per member per alert); null = never told. Written only by the API
--    worker. The incident's one row per member already exists (unique `incident_id`,
--    `member_user_id`; a re-notify updates it in place), so no new table and no new event type: the
--    notice never shows in the incident's events, timeline or activity log.
--
-- Additive and backward compatible (AGENTS.md rule 4): two nullable columns, one trigger function
-- (not callable by the app roles), one trigger and one check that every existing row meets after the
-- back-fill. Both tables keep their lockdown. Re-runnable on a fresh database after the baseline.

alter table public.notification_deliveries
  add column if not exists final_at timestamptz null;

update public.notification_deliveries
   set final_at = coalesce(sent_at, updated_at)
 where status <> 'queued'
   and final_at is null;

create or replace function public.notification_deliveries_fill_final_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'queued' and new.final_at is null then
    new.final_at := coalesce(new.sent_at, now());
  end if;
  return new;
end;
$$;

revoke all on function public.notification_deliveries_fill_final_at() from public;
revoke all on function public.notification_deliveries_fill_final_at() from anon;
revoke all on function public.notification_deliveries_fill_final_at() from authenticated;

create or replace trigger notification_deliveries_fill_final_at
  before insert or update on public.notification_deliveries
  for each row
  execute function public.notification_deliveries_fill_final_at();

alter table public.notification_deliveries
  drop constraint if exists notification_deliveries_final_at_shape,
  add constraint notification_deliveries_final_at_shape
    check ((status = 'queued') = (final_at is null));

comment on column public.notification_deliveries.final_at is
  'SCRUM-67 (D73): when the row reached its final state (sent/delivered = sent_at; failed = the last '
  'failed attempt; skipped = when it was skipped). Null exactly while queued.';

alter table public.incident_deliveries
  add column if not exists delivery_failed_notified_at timestamptz null;

comment on column public.incident_deliveries.delivery_failed_notified_at is
  'SCRUM-71 (D73): when the resident was told this member did not receive the alert (incident.'
  'delivery_failed + a push to the resident); at most once per member per incident. Written only by '
  'the API worker.';
