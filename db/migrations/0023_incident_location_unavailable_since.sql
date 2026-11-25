-- SCRUM-68 (last-known location fallback), decision D74 (epic §18.1 P5).
--
-- `incidents.location_unavailable_since` (timestamptz, nullable): since when the resident's phone
-- reports that live location is unavailable (`POST /v1/incidents/{id}/locations` with
-- `location_source = 'unavailable'`). Null = live location is not reported unavailable (no report
-- yet, or a newer fix arrived after the last `unavailable` report).
--
-- With D74 an `unavailable` report no longer wipes the stored fix: when the incident already has a
-- position (`location_source` `current` / `last_known`), the five location columns are kept
-- unchanged (the last known coordinates, accuracy, capture time and source) and only this column is
-- set (first report wins: repeated `unavailable` reports keep the earliest time). When the incident
-- never had a position, the report is stored as before (`location_source = 'unavailable'`, the four
-- position columns null) and this column is set too. The next `current` / `last_known` fix writes the
-- five columns as before and clears this column.
--
-- Why a separate column and not a widened `incidents_location_shape` check (`unavailable` with
-- coordinates): every existing key keeps its meaning (`location_source` names the stored fix; the
-- coordinates are null exactly when no fix is stored), so app builds that do not know the new key
-- see a stored fix whose `location_captured_at` stops moving, which they already label
-- "Last known · N min ago" (SCRUM-62), instead of losing the map. No existing check changes.
--
-- Check `incidents_location_unavailable_since_shape`: the column is set only on an incident that has
-- had a location report (`location_source` not null). Every existing row meets it (the column is new).
--
-- Additive and backward compatible (AGENTS.md rule 4): one nullable column and one check. Written
-- only by the API. Re-runnable on a fresh database after the baseline.

alter table public.incidents
  add column if not exists location_unavailable_since timestamptz null;

alter table public.incidents
  drop constraint if exists incidents_location_unavailable_since_shape,
  add constraint incidents_location_unavailable_since_shape
    check (location_unavailable_since is null or location_source is not null);

comment on column public.incidents.location_unavailable_since is
  'SCRUM-68 (D74): since when the resident''s phone reports live location unavailable; null = not '
  'reported unavailable (or a newer fix arrived since). An unavailable report keeps the last fix in '
  'the five location columns; with no fix ever stored, location_source is unavailable.';
