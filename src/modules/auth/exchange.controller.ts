import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { DomainError, Operation } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { AuditService } from '../audit/audit.service';
import { requireJsonObject } from '../incidents/incident-input';
import { INSTALLATION_ID_HEADER } from '../notifications/device-input';
import { deviceFrom, optionalInstallationId } from './auth-input';
import { AuthOperationFailedError, runAuthTransaction } from './auth-transaction';
import {
  exchangeRequestSchema,
  INSTALLATION_ID_HEADER_OPTIONAL,
  sessionSchema,
} from './auth.schemas';
import { LegacyUsers } from './legacy-users';
import { clientContext, type SessionJson, SessionsService } from './sessions.service';
import { UsersRepository } from './users.repository';

const UNIQUE_VIOLATION = '23505';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one-time session exchange (API-100-59 AC1, D8): a signed-in user of the old app sends their
 * valid SUPABASE access token (as the bearer) and gets an API session, so the switch logs nobody
 * out. Once per Supabase session (`session_id` claim, unique in `device_sessions`); only while
 * Supabase tokens are accepted (the guard refuses them after SUPABASE_JWT_ACCEPT turns off). An API
 * token cannot be exchanged (403 `auth:exchange_not_allowed`). The user is moved from Supabase Auth
 * first when needed (API-100-58).
 */
@Controller('auth')
export class ExchangeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsService,
    private readonly legacy: LegacyUsers,
    private readonly audit: AuditService,
  ) {}

  @Post('exchange')
  @HttpCode(200)
  @Operation('auth')
  @ApiContract({
    operationId: 'exchangeSupabaseSession',
    summary: 'Move a signed-in Supabase session to an API session (once, at the app switch)',
    tag: 'auth',
    headers: [INSTALLATION_ID_HEADER_OPTIONAL],
    body: { name: 'ExchangeRequest', schema: exchangeRequestSchema },
    responses: {
      200: {
        description:
          'An API session for the user of the Supabase access token sent as the bearer. Keep using the Supabase session no longer: this API session replaces it.',
        name: 'Session',
        schema: sessionSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'auth:invalid_device',
      'auth:exchange_not_allowed',
      'auth:session_already_exchanged',
      'auth:user_disabled',
    ],
  })
  async exchange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
    @Headers('user-agent') userAgent: unknown,
  ): Promise<SessionJson> {
    const input = requireJsonObject(body);
    const device = deviceFrom(input.device, optionalInstallationId(installationId));
    if (user.issuer !== 'supabase' || !user.sessionId || !UUID.test(user.sessionId)) {
      throw new DomainError('auth:exchange_not_allowed');
    }
    const supabaseSession = user.sessionId.toLowerCase();
    await this.legacy.migrateById(user.id);
    const client = clientContext(userAgent);
    let pending;
    try {
      pending = await runAuthTransaction(this.database, async (tx) => {
        const row = await this.users.byId(tx, user.id, true);
        if (!row) throw new DomainError('auth:not_authenticated');
        if (row.disabled) throw new DomainError('auth:user_disabled');
        const opened = await this.sessions.open(
          tx,
          user.id,
          'exchange',
          device,
          client,
          supabaseSession,
        );
        await this.audit.record(
          {
            action: 'auth.session.exchanged',
            actor_user_id: user.id,
            actor_session_id: opened.sessionId,
            target_type: 'device_session',
            target_id: opened.sessionId,
          },
          tx,
        );
        return opened;
      });
    } catch (error) {
      if (error instanceof AuthOperationFailedError && error.sqlState === UNIQUE_VIOLATION) {
        throw new DomainError('auth:session_already_exchanged');
      }
      throw error;
    }
    return this.sessions.finish(pending);
  }
}
