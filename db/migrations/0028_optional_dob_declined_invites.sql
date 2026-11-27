-- Gaps_Adressed Stage 3: [B2] date of birth optional (SCRUM-17) and [B10b] declined invitations in
-- the owner's list (SCRUM-28).
--
-- [B2] `profiles.date_of_birth` DROP NOT NULL: SCRUM-17 requires only the full name and one verified
-- contact; the date of birth may be left empty (null = not given, hidden on views). Existing rows
-- keep their value. The API's personal-info save and profile set-up accept it missing or null.
--
-- [B10b] `safety_circle_members.declined_at` (timestamptz, nullable): set when the INVITEE declines
-- (`POST /v1/invites/.../decline`), cleared when the owner re-invites (refresh / resend) and by an
-- owner cancel, which still stores `status = 'declined'` (as before). The owner's member list shows
-- a stored `declined` row only when `declined_at` is set (status "declined": the invitee said no)
-- and hides an owner-canceled one. A value left on a row that is no longer `declined` means
-- nothing (every path back to `declined` writes it). Existing declined rows: an invitee decline
-- always wrote the invitee's `user_id` (an owner cancel of an unclaimed invite did not), so those get
-- `declined_at = invite_canceled_at` (else `updated_at`); best effort for old data (no production
-- users).
--
-- Additive and backward compatible (AGENTS.md rule 4): a NOT NULL dropped (widened) and one
-- nullable column. Written only by the API. Re-runnable on a fresh database after the baseline.

alter table public.profiles
  alter column date_of_birth drop not null;

comment on column public.profiles.date_of_birth is
  'Date of birth (YYYY-MM-DD). Optional since Stage 3 [B2] (SCRUM-17): null = not given, hidden on views.';

alter table public.safety_circle_members
  add column if not exists declined_at timestamptz null;

update public.safety_circle_members
   set declined_at = coalesce(invite_canceled_at, updated_at)
 where status = 'declined'
   and user_id is not null
   and declined_at is null;

comment on column public.safety_circle_members.declined_at is
  'Stage 3 [B10b]: when the invitee declined (null for an owner cancel and every other row); the '
  'owner list shows a declined row only when set. Cleared by a re-invite.';
