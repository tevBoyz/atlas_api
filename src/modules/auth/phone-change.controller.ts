import { Body, Controller, HttpCode, Post, Put } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireJsonObject } from '../incidents/incident-input';
import { authPhoneFrom, otpCodeFrom } from './auth-input';
import { SEND_LIMIT, VERIFY_LIMIT } from './auth-limits';
import {
  phoneChangeAcceptedSchema,
  phoneChangedSchema,
  phoneChangeRequestSchema,
  phoneChangeVerifyRequestSchema,
} from './auth.schemas';
import { OtpService } from './otp.service';
import type { UserJson } from './users.repository';

export interface PhoneChangeAccepted {
  verification: { channel: 'phone'; expires_in_seconds: number; resends_remaining: number };
}

/**
 * A18 (stage 7.1c, D39): change my phone number. `PUT` texts a code to the new number (calling it
 * again is the resend); `POST .../verify` checks it and only then makes the number the account's
 * confirmed phone. Limited per IP like the OTP routes and, in the service, per number.
 */
@Controller('me/phone')
export class PhoneChangeController {
  constructor(private readonly otp: OtpService) {}

  @Put()
  @HttpCode(202)
  @Operation('auth')
  @RateLimit(SEND_LIMIT)
  @ApiContract({
    operationId: 'changePhone',
    summary: 'Text a code to my new phone number (the number changes only once it is verified)',
    tag: 'auth',
    body: { name: 'PhoneChangeRequest', schema: phoneChangeRequestSchema },
    responses: {
      202: {
        description:
          'Accepted: a code valid 600 s is texted to the new number. The answer is the same when another account holds that number (no code is sent then). Calling it again sends a new code; at most 4 codes per number per 15 minutes.',
        name: 'PhoneChangeAccepted',
        schema: phoneChangeAcceptedSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'auth:invalid_phone',
      'auth:otp_resend_limit',
      'auth:sms_unavailable',
      'auth:user_disabled',
    ],
  })
  async change(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<PhoneChangeAccepted> {
    const input = requireJsonObject(body);
    const sent = await this.otp.startPhoneChange(authPhoneFrom(input.phone), user);
    return { verification: { channel: 'phone', ...sent } };
  }

  @Post('verify')
  @HttpCode(200)
  @Operation('auth')
  @RateLimit(VERIFY_LIMIT)
  @ApiContract({
    operationId: 'verifyPhoneChange',
    summary: 'Verify the code texted to my new phone number; the number becomes my confirmed phone',
    tag: 'auth',
    body: { name: 'PhoneChangeVerifyRequest', schema: phoneChangeVerifyRequestSchema },
    responses: {
      200: {
        description: 'The new number is the account phone, confirmed.',
        name: 'PhoneChanged',
        schema: phoneChangedSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'auth:invalid_phone',
      'auth:otp_invalid',
      'auth:otp_expired',
      'auth:otp_invalidated',
      'auth:sms_unavailable',
      'auth:user_disabled',
    ],
  })
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<{ user: UserJson }> {
    const input = requireJsonObject(body);
    return this.otp.verifyPhoneChange(authPhoneFrom(input.phone), otpCodeFrom(input.code), user);
  }
}
