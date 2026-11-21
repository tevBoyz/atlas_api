-- Phase 7 stage 7.1b (D38): `PUT /v1/auth/password` (A16) revokes the user's OTHER sessions with
-- the new reason `password_change` (a reset keeps `password_reset`). The check constraint of
-- `device_sessions.revoke_reason` is widened by one value; every existing value stays valid.
--
-- Backward compatible (AGENTS.md rule 4): only the set of allowed values grows; the table is
-- written only by the API. Re-runnable on a fresh database after the baseline.

alter table public.device_sessions
  drop constraint if exists device_sessions_revoke_reason_check,
  add constraint device_sessions_revoke_reason_check
    check (revoke_reason is null
           or revoke_reason in ('logout', 'logout_all', 'deleted', 'refresh_token_reused', 'idle',
                                'password_reset', 'password_change'));
