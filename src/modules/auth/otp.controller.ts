import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';

import {
  type AuthenticatedUser,
  bearerToken,
  TOKEN_VERIFIER,
  TokenRejectedError,
  type TokenVerifier,
} from '../../common/auth';
import { DomainError } from '../../common/errors';
import { Public } from '../../common/guards/route-access';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireJsonObject } from '../incidents/incident-input';
import { INSTALLATION_ID_HEADER } from '../notifications/device-input';
import {
  authPhoneFrom,
  deviceFrom,
  optionalInstallationId,
  otpCodeFrom,
  otpPurposeFrom,
} from './auth-input';
import { SEND_LIMIT, VERIFY_LIMIT } from './auth-limits';
import {
  INSTALLATION_ID_HEADER_OPTIONAL,
  otpSendRequestSchema,
  otpSentSchema,
  otpVerifiedSchema,
  otpVerifyRequestSchema,
} from './auth.schemas';
import { type OtpSent, OtpService } from './otp.service';
import { clientContext, type SessionJson } from './sessions.service';
import type { UserJson } from './users.repository';

const SEND_ERRORS = [
  'validation:invalid_request',
  'auth:invalid_phone',
  'auth:not_authenticated',
  'auth:otp_resend_limit',
  'auth:sms_unavailable',
] as const;

/**
 * Phone OTP (API-100-53, spec §11.3 A4-A6). Public routes, limited per IP and, in the service, per
 * phone number. `purpose: verify_phone` needs the account's access token in `Authorization` (read
 * here, since the routes also serve `sign_in` without one).
 */
@Controller('auth/otp')
@Public()
export class OtpController {
  constructor(
    private readonly otp: OtpService,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  /** The caller for `verify_phone` (401 `auth:not_authenticated` without a valid token). */
  private async callerOf(authorization: unknown): Promise<AuthenticatedUser> {
    const token = bearerToken(typeof authorization === 'string' ? authorization : undefined);
    if (!token) throw new DomainError('auth:not_authenticated');
    try {
      return await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof TokenRejectedError) throw new DomainError('auth:not_authenticated');
      throw error;
    }
  }

  private async sendFrom(body: unknown, authorization: unknown): Promise<OtpSent> {
    const input = requireJsonObject(body);
    const phone = authPhoneFrom(input.phone);
    const purpose = otpPurposeFrom(input.purpose);
    const caller = purpose === 'verify_phone' ? await this.callerOf(authorization) : null;
    return this.otp.send(phone, purpose, caller);
  }

  /** A4. */
  @Post('send')
  @HttpCode(202)
  @RateLimit(SEND_LIMIT)
  @ApiContract({
    operationId: 'sendOtp',
    summary: 'Text a 6-digit code to a phone (sign in, or verify my own number)',
    tag: 'auth',
    body: { name: 'OtpSendRequest', schema: otpSendRequestSchema },
    responses: {
      202: {
        description:
          "Accepted: a code valid 600 s is texted when the number belongs to an account (sign_in) or is the caller's own (verify_phone); the answer is the same for an unknown number. At most 4 codes per number per 15 minutes.",
        name: 'OtpSent',
        schema: otpSentSchema,
      },
    },
    errors: [...SEND_ERRORS],
  })
  send(@Body() body: unknown, @Headers('authorization') authorization: unknown): Promise<OtpSent> {
    return this.sendFrom(body, authorization);
  }

  /** A5: the same as A4 (a new code; the failed-attempt count starts again). */
  @Post('resend')
  @HttpCode(202)
  @RateLimit(SEND_LIMIT)
  @ApiContract({
    operationId: 'resendOtp',
    summary: 'Text a new code (resets the failed attempts)',
    tag: 'auth',
    body: { name: 'OtpSendRequest', schema: otpSendRequestSchema },
    responses: { 202: { description: 'As sendOtp.', name: 'OtpSent', schema: otpSentSchema } },
    errors: [...SEND_ERRORS],
  })
  resend(
    @Body() body: unknown,
    @Headers('authorization') authorization: unknown,
  ): Promise<OtpSent> {
    return this.sendFrom(body, authorization);
  }

  /** A6. */
  @Post('verify')
  @HttpCode(200)
  @RateLimit(VERIFY_LIMIT)
  @ApiContract({
    operationId: 'verifyOtp',
    summary: 'Check a texted code: sign in (Session) or confirm my number ({user})',
    tag: 'auth',
    headers: [INSTALLATION_ID_HEADER_OPTIONAL],
    body: { name: 'OtpVerifyRequest', schema: otpVerifyRequestSchema },
    responses: {
      200: {
        description:
          '`sign_in`: a `Session` (every key). `verify_phone`: `{user}` only, with `phone_confirmed_at` set.',
        name: 'OtpVerified',
        schema: otpVerifiedSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'auth:invalid_phone',
      'auth:invalid_device',
      'auth:not_authenticated',
      'auth:otp_invalid',
      'auth:otp_expired',
      'auth:otp_invalidated',
      'auth:sms_unavailable',
      'auth:user_disabled',
    ],
  })
  async verify(
    @Body() body: unknown,
    @Headers('authorization') authorization: unknown,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
    @Headers('user-agent') userAgent: unknown,
  ): Promise<SessionJson | { user: UserJson }> {
    const input = requireJsonObject(body);
    const phone = authPhoneFrom(input.phone);
    const purpose = otpPurposeFrom(input.purpose);
    const code = otpCodeFrom(input.code);
    if (purpose === 'verify_phone') {
      return this.otp.verifyPhone(phone, code, await this.callerOf(authorization));
    }
    const device = deviceFrom(input.device, optionalInstallationId(installationId));
    return this.otp.verifySignIn(phone, code, device, clientContext(userAgent));
  }
}
