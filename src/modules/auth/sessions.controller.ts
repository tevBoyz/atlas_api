import { Body, Controller, Delete, Get, Headers, HttpCode, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { DomainError, Operation, ZodParam } from '../../common/errors';
import { Public } from '../../common/guards/route-access';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { refreshTokenFrom } from './auth-input';
import { REFRESH_LIMIT } from './auth-limits';
import {
  refreshRequestSchema,
  sessionIdParamsSchema,
  sessionInfoSchema,
  sessionSchema,
  userSchema,
} from './auth.schemas';
import { runAuthTransaction } from './auth-transaction';
import { LegacyUsers } from './legacy-users';
import type { SessionListEntry } from './sessions.repository';
import { clientContext, type SessionJson, SessionsService } from './sessions.service';
import { type UserJson, UsersRepository } from './users.repository';
import { DatabaseService } from '../../db/database.service';
import { z } from 'zod';

/**
 * Refresh rotation, sign-out and device sessions (API-100-56, spec §11.3 A11-A13, A17, A19, A20).
 * Refresh is public (the access token may have expired) and limited per IP (150 per 5 minutes, the
 * Supabase refresh limit of today); the others need an access token (own, or Supabase during the
 * dual-token window) and use the default per-user limit.
 */
@Controller()
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly users: UsersRepository,
    private readonly legacy: LegacyUsers,
    private readonly database: DatabaseService,
  ) {}

  /** A11. */
  @Post('auth/refresh')
  @Public()
  @HttpCode(200)
  @RateLimit(REFRESH_LIMIT)
  @ApiContract({
    operationId: 'refreshSession',
    summary: 'Exchange the refresh token for a new session (the old refresh token is used up)',
    tag: 'auth',
    body: { name: 'RefreshRequest', schema: refreshRequestSchema },
    responses: {
      200: {
        description:
          'A new access token and a NEW refresh token (rotation: the one sent can never be used again).',
        name: 'Session',
        schema: sessionSchema,
      },
    },
    errors: ['validation:invalid_request', 'auth:session_expired', 'auth:refresh_token_reused'],
  })
  refresh(@Body() body: unknown, @Headers('user-agent') userAgent: unknown): Promise<SessionJson> {
    return this.sessions.refresh(refreshTokenFrom(body), clientContext(userAgent));
  }

  /** A12: this device's session ends and its push token is cleared. */
  @Post('auth/logout')
  @HttpCode(204)
  @Operation('auth')
  @ApiContract({
    operationId: 'signOut',
    summary: "End this device's session (and clear its push token)",
    tag: 'auth',
    responses: {
      204: {
        description:
          'Signed out on this device. With a Supabase access token (dual-token window) there is no API session to end: 204, nothing changes.',
      },
    },
  })
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.sessions.logout(user);
  }

  /** A13: every session of the user ends (today's app default, `signOut(scope: global)`). */
  @Post('auth/logout-all')
  @HttpCode(204)
  @Operation('auth')
  @ApiContract({
    operationId: 'signOutEverywhere',
    summary: 'End every session of my account on every device',
    tag: 'auth',
    responses: {
      204: {
        description:
          'Every session is revoked and every device of the account loses its push token.',
      },
    },
  })
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.sessions.logoutAll(user);
  }

  /** A17. */
  @Get('me')
  @Operation('auth')
  @ApiContract({
    operationId: 'getCurrentUser',
    summary: 'My account: email, phone, confirmations and sign-in methods',
    tag: 'auth',
    responses: { 200: { description: 'User.', name: 'User', schema: userSchema } },
  })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserJson> {
    // A Supabase-token caller not moved yet (dual-token window) is moved now (API-100-58).
    await this.legacy.migrateById(user.id);
    const json = await runAuthTransaction(this.database, (tx) => this.users.userJson(tx, user.id));
    if (!json) throw new DomainError('auth:not_authenticated');
    return json;
  }

  /** A19. */
  @Get('me/sessions')
  @Operation('auth')
  @ApiContract({
    operationId: 'listMySessions',
    summary: 'My signed-in devices (sessions), most recently used first',
    tag: 'auth',
    responses: {
      200: {
        description:
          'Live sessions (not signed out, used within 7 days). `current` marks the one of this access token.',
        schema: z.array(sessionInfoSchema),
      },
    },
  })
  list(@CurrentUser() user: AuthenticatedUser): Promise<SessionListEntry[]> {
    return this.sessions.list(user);
  }

  /** A20. */
  @Delete('me/sessions/:session_id')
  @HttpCode(204)
  @Operation('auth')
  @ApiContract({
    operationId: 'endMySession',
    summary: 'Sign out one of my devices',
    tag: 'auth',
    params: sessionIdParamsSchema,
    responses: {
      204: { description: 'That session is revoked (its device loses its push token).' },
    },
    errors: ['auth:session_not_found'],
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @ZodParam('session_id', z.uuid().transform((id) => id.toLowerCase()), {
      fallback: 'auth:session_not_found',
    })
    sessionId: string,
  ): Promise<void> {
    await this.sessions.remove(user, sessionId);
  }
}
