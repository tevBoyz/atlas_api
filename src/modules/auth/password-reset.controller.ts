import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';

import { Public } from '../../common/guards/route-access';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireJsonObject } from '../incidents/incident-input';
import { INSTALLATION_ID_HEADER } from '../notifications/device-input';
import { deviceFrom, linkTokenFrom, optionalInstallationId, signupEmailFrom } from './auth-input';
import { SEND_LIMIT, VERIFY_LIMIT } from './auth-limits';
import {
  INSTALLATION_ID_HEADER_OPTIONAL,
  passwordForgotRequestSchema,
  passwordResetRequestSchema,
  sessionSchema,
} from './auth.schemas';
import { PasswordResetService } from './password-reset.service';
import { clientContext, type SessionJson } from './sessions.service';

/** Password reset (API-100-57, spec §11.3 A14/A15). Public, limited per IP and per address. */
@Controller('auth/password')
@Public()
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService) {}

  /** A14. Always 202. */
  @Post('forgot')
  @HttpCode(202)
  @RateLimit(SEND_LIMIT)
  @ApiContract({
    operationId: 'forgotPassword',
    summary: 'Email a password reset link (type=recovery)',
    tag: 'auth',
    body: { name: 'PasswordForgotRequest', schema: passwordForgotRequestSchema },
    responses: {
      202: {
        description:
          'Accepted. A link is emailed only when the address has an account; the answer is the same either way.',
      },
    },
    errors: ['validation:invalid_request', 'auth:invalid_email', 'auth:over_email_send_rate_limit'],
  })
  async forgot(@Body() body: unknown): Promise<void> {
    const input = requireJsonObject(body);
    await this.resets.forgot(signupEmailFrom(input.email));
  }

  /** A15. */
  @Post('reset')
  @HttpCode(200)
  @RateLimit(VERIFY_LIMIT)
  @ApiContract({
    operationId: 'resetPassword',
    summary: 'Set a new password with the recovery link token and sign in',
    tag: 'auth',
    headers: [INSTALLATION_ID_HEADER_OPTIONAL],
    body: { name: 'PasswordResetRequest', schema: passwordResetRequestSchema },
    responses: {
      200: {
        description:
          'Password changed; every other session of the account is signed out; a new session.',
        name: 'Session',
        schema: sessionSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'auth:link_invalid',
      'auth:link_expired',
      'auth:weak_password',
      'auth:same_password',
      'auth:invalid_device',
      'auth:user_disabled',
    ],
  })
  reset(
    @Body() body: unknown,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
    @Headers('user-agent') userAgent: unknown,
  ): Promise<SessionJson> {
    const input = requireJsonObject(body);
    const token = linkTokenFrom(input.token);
    const device = deviceFrom(input.device, optionalInstallationId(installationId));
    return this.resets.reset(token, input.new_password, device, clientContext(userAgent));
  }
}
