import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../db/database.service';

/** What the guard needs to know about the session of an own access token. */
export type SessionState = 'live' | 'revoked' | 'unknown';

/** DI token of the {@link SessionStatusReader}. */
export const SESSION_STATUS_READER = Symbol('SESSION_STATUS_READER');

/**
 * Reads whether an own token's session may still be used (API-100-51 AC3): the session exists,
 * belongs to the token's user, is not revoked (`device_sessions.revoked_at`), and the user is not
 * disabled. One primary-key read per authenticated request with an own token.
 */
export interface SessionStatusReader {
  stateOf(sessionId: string, userId: string): Promise<SessionState>;
}

@Injectable()
export class DatabaseSessionStatusReader implements SessionStatusReader {
  constructor(private readonly database: DatabaseService) {}

  async stateOf(sessionId: string, userId: string): Promise<SessionState> {
    const rows = await this.database.query<{ live: boolean }>(
      `select (s.revoked_at is null and u.disabled_at is null) as live
         from public.device_sessions s
         join public.users u on u.id = s.user_id
        where s.id = $1 and s.user_id = $2`,
      [sessionId, userId],
    );
    if (rows.length === 0) return 'unknown';
    return rows[0].live ? 'live' : 'revoked';
  }
}
