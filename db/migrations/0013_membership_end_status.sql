-- SCRUM-30 (remove a member) + SCRUM-31 (leave a Safety Circle), decision D44: the API no longer
-- deletes the member row when a membership ends; it keeps the row as history with the stored status
-- `removed` (the owner removed an active member) or `left` (the member left), and the time it
-- ended in the new column `ended_at`.
--
-- Backward compatible (AGENTS.md rule 4): the set of allowed statuses only grows (every existing
-- value stays valid) and `ended_at` is a new nullable column. Nothing else changes:
-- - `safety_circle_members_activated_shape` (active ⇔ `activated_at` set) stays as it is: an ended
--   row is not `active`, so its trigger `set_safety_circle_members_activated_at` clears
--   `activated_at`, as for every non-active row. No `last_activated_at` is added: the accept time
--   of an accepted row is its `invite_consumed_at` (kept), and the audit log has the rest.
-- - Ended rows hold no slot (`_circle_invite_holds_slot` counts `active` and valid `pending` only),
--   never pass the membership checks (`status = 'active'`), and are never shown by the API.
-- - The unique indexes `(circle_id, user_id)` / `(circle_id, phone)` are not changed: the API
--   releases an ended row's `user_id` (new claim, D41/D44) or `phone` (new phone invite) when the
--   same person is invited again, keeping the rest of the row.
-- Re-runnable on a fresh database after the baseline.

alter table public.safety_circle_members
  drop constraint if exists safety_circle_members_status_allowed,
  add constraint safety_circle_members_status_allowed
    check (status = any (array['pending'::text, 'active'::text, 'declined'::text,
                               'removed'::text, 'left'::text]));

alter table public.safety_circle_members
  add column if not exists ended_at timestamptz;

comment on column public.safety_circle_members.ended_at is
  'When the membership ended: set by the API together with status removed (owner removed the '
  'member) or left (the member left), D44. Null for every other status.';

alter table public.safety_circle_members
  drop constraint if exists safety_circle_members_ended_shape,
  add constraint safety_circle_members_ended_shape
    check ((status in ('removed', 'left')) = (ended_at is not null));
