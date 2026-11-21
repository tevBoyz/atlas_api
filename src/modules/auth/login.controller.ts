import { Body, Controller, Get, Header, Headers, HttpCode, Post, Query } from '@nestjs/common';

import { Public } from '../../common/guards/route-access';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { INSTALLATION_ID_HEADER } from '../notifications/device-input';
import { identifierFrom, loginFrom, optionalInstallationId } from './auth-input';
import { LOGIN_STATUS_LIMIT } from './auth-limits';
import {
  INSTALLATION_ID_HEADER_OPTIONAL,
  lockoutStatusQuerySchema,
  lockoutStatusSchema,
  loginRequestSchema,
  sessionSchema,
} from './auth.schemas';
import type { LockoutStatus } from './lockout.repository';
import { LoginService } from './login.service';
import { clientContext, type SessionJson } from './sessions.service';

const IDENTIFIER_ERRORS = [
  'validation:invalid_request',
  'login_lockout:identifier_exclusive',
  'login_lockout:identifier_required',
  'login_lockout:email_required',
  'login_lockout:invalid_email',
  'login_lockout:phone_required',
  'login_lockout:invalid_phone',
] as const;

/**
 * Password sign-in and the lockout status (API-100-54, spec §11.3 A7/A8). Public; both share the
 * per-IP budget of `login_lockout_status` (60 per 5 minutes, `login_lockout:rate_limited`), because
 * the app read the status before every sign-in.
 */
@Controller('auth')
@Public()
export class LoginController {
  constructor(private readonly logins: LoginService) {}

  /** A7. */
  @Post('login')
  @HttpCode(200)
  @RateLimit(LOGIN_STATUS_LIMIT)
  @ApiContract({
    operationId: 'signInWithPassword',
    summary: 'Sign in with email or phone and password (with the 5 / 15 min lockout)',
    tag: 'auth',
    headers: [INSTALLATION_ID_HEADER_OPTIONAL],
    body: { name: 'LoginRequest', schema: loginRequestSchema },
    responses: { 200: { description: 'A new session.', name: 'Session', schema: sessionSchema } },
    errors: [
      ...IDENTIFIER_ERRORS,
      'auth:invalid_device',
      'auth:invalid_credentials',
      'login_lockout:locked',
      'auth:email_not_confirmed',
      'auth:phone_not_confirmed',
      'auth:user_disabled',
      'login_lockout:rate_limited',
    ],
  })
  login(
    @Body() body: unknown,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
    @Headers('user-agent') userAgent: unknown,
  ): Promise<SessionJson> {
    return this.logins.login(
      loginFrom(body, optionalInstallationId(installationId)),
      clientContext(userAgent),
    );
  }

  /** A8 (`login_lockout_status`): the same shape for known and unknown identifiers. */
  @Get('lockout-status')
  @RateLimit(LOGIN_STATUS_LIMIT)
  @Header('cache-control', 'no-store')
  @ApiContract({
    operationId: 'loginLockoutStatus',
    summary: 'Is this email / phone locked, and until when (for the sign-in screen)',
    tag: 'auth',
    query: lockoutStatusQuerySchema,
    responses: {
      200: { description: 'LockoutStatus.', name: 'LockoutStatus', schema: lockoutStatusSchema },
    },
    errors: [...IDENTIFIER_ERRORS, 'login_lockout:rate_limited'],
  })
  status(@Query() query: Record<string, unknown>): Promise<LockoutStatus> {
    return this.logins.status(identifierFrom(query.email, query.phone));
  }
}
