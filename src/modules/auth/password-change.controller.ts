import { Body, Controller, HttpCode, Put } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { DomainError, Operation } from '../../common/errors';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireJsonObject } from '../incidents/incident-input';
import { PASSWORD_INPUT_MAX } from './auth-input';
import { PASSWORD_CHANGE_LIMIT } from './auth-limits';
import { passwordChangeRequestSchema } from './auth.schemas';
import { PasswordChangeService } from './password-change.service';

/** A16 (stage 7.1b, D38): change the password while signed in. */
@Controller('auth')
export class PasswordChangeController {
  constructor(private readonly changes: PasswordChangeService) {}

  @Put('password')
  @HttpCode(204)
  @Operation('auth')
  @RateLimit(PASSWORD_CHANGE_LIMIT)
  @ApiContract({
    operationId: 'changePassword',
    summary: 'Change my password (current password required); my other devices are signed out',
    tag: 'auth',
    body: { name: 'PasswordChangeRequest', schema: passwordChangeRequestSchema },
    responses: {
      204: {
        description:
          'Password changed. Every other session of the account is signed out; this one stays. At most 10 attempts per user per 15 minutes.',
      },
    },
    errors: [
      'validation:invalid_request',
      'auth:invalid_credentials',
      'auth:weak_password',
      'auth:same_password',
      'auth:user_disabled',
      'rate_limit:exceeded',
    ],
  })
  async change(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<void> {
    const input = requireJsonObject(body);
    const current = input.current_password;
    if (typeof current !== 'string' || current.length > PASSWORD_INPUT_MAX) {
      throw new DomainError('validation:invalid_request', {
        details: { field: 'current_password' },
      });
    }
    await this.changes.change(user, current, input.new_password);
  }
}
