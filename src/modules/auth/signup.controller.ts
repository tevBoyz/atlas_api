import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';

import { Public } from '../../common/guards/route-access';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import {
  deviceFrom,
  emailResendFrom,
  linkTokenFrom,
  optionalInstallationId,
  signupFrom,
} from './auth-input';
import { SEND_LIMIT, SIGN_UP_LIMIT, VERIFY_LIMIT } from './auth-limits';
import {
  emailResendRequestSchema,
  emailVerifyRequestSchema,
  INSTALLATION_ID_HEADER_OPTIONAL,
  sessionSchema,
  signupAcceptedSchema,
  signupRequestSchema,
} from './auth.schemas';
import { requireJsonObject } from '../incidents/incident-input';
import { INSTALLATION_ID_HEADER } from '../notifications/device-input';
import { clientContext, type SessionJson } from './sessions.service';
import { type SignupAccepted, SignupService } from './signup.service';

/**
 * Sign-up and email verification (API-100-52, spec §11.3 A1-A3). Public routes, limited per IP;
 * emails are additionally limited per address (4 per 15 minutes).
 */
@Controller('auth')
@Public()
export class SignupController {
  constructor(private readonly signups: SignupService) {}

  /** A1. Always 202 "check your email" (D5b): never says whether the email or phone exists. */
  @Post('signup')
  @HttpCode(202)
  @RateLimit(SIGN_UP_LIMIT)
  @ApiContract({
    operationId: 'signUp',
    summary: 'Create an account (email, password, phone, name); a confirmation link is emailed',
    tag: 'auth',
    headers: [INSTALLATION_ID_HEADER_OPTIONAL],
    body: { name: 'SignupRequest', schema: signupRequestSchema },
    responses: {
      202: {
        description:
          'Check your email. The same answer whether or not the address (or phone) already has an account (D5b): an unconfirmed account gets a new link, a confirmed one gets nothing. No session until the email is confirmed.',
        name: 'SignupAccepted',
        schema: signupAcceptedSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'auth:invalid_email',
      'auth:weak_password',
      'auth:invalid_phone',
      'auth:invalid_full_name',
      'auth:invalid_device',
      'auth:over_email_send_rate_limit',
    ],
  })
  signup(
    @Body() body: unknown,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
  ): Promise<SignupAccepted> {
    return this.signups.signup(signupFrom(body, optionalInstallationId(installationId)));
  }

  /** A2. The emailed link's token (`type=signup` or `type=magiclink`) → a session. */
  @Post('email/verify')
  @HttpCode(200)
  @RateLimit(VERIFY_LIMIT)
  @ApiContract({
    operationId: 'verifyEmail',
    summary: 'Confirm the email with the link token and sign in',
    tag: 'auth',
    headers: [INSTALLATION_ID_HEADER_OPTIONAL],
    body: { name: 'EmailVerifyRequest', schema: emailVerifyRequestSchema },
    responses: {
      200: {
        description: 'Email confirmed; a new session.',
        name: 'Session',
        schema: sessionSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'auth:link_invalid',
      'auth:link_expired',
      'auth:invalid_device',
      'auth:user_disabled',
    ],
  })
  verify(
    @Body() body: unknown,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
    @Headers('user-agent') userAgent: unknown,
  ): Promise<SessionJson> {
    const input = requireJsonObject(body);
    const token = linkTokenFrom(input.token);
    const device = deviceFrom(input.device, optionalInstallationId(installationId));
    return this.signups.verifyEmail(token, device, clientContext(userAgent));
  }

  /** A3. Always 202, also for an unknown address (no enumeration). */
  @Post('email/resend')
  @HttpCode(202)
  @RateLimit(SEND_LIMIT)
  @ApiContract({
    operationId: 'resendEmail',
    summary: 'Email a new confirmation link (signup) or a sign-in link (magic_link)',
    tag: 'auth',
    body: { name: 'EmailResendRequest', schema: emailResendRequestSchema },
    responses: {
      202: {
        description:
          'Accepted. Sent only when it applies (signup: an unconfirmed account; magic_link: any account); the answer is the same either way.',
      },
    },
    errors: ['validation:invalid_request', 'auth:invalid_email', 'auth:over_email_send_rate_limit'],
  })
  async resend(@Body() body: unknown): Promise<void> {
    const { email, purpose } = emailResendFrom(body);
    await this.signups.resend(email, purpose);
  }
}
