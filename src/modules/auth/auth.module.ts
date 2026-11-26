import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../../common/auth';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';
import { AuditModule } from '../audit/audit.module';
import { ChannelSenders } from '../notifications/channels/channel-senders';
import { AccessTokenSigner } from './access-tokens';
import { AuthLimits } from './auth-limits';
import { AuthLinksRepository } from './auth-links.repository';
import { AuthMessenger } from './auth-messenger';
import { ID_TOKEN_VERIFIER, JoseIdTokenVerifier } from './id-token-verifier';
import { JwksController } from './jwks.controller';
import { LockoutRepository } from './lockout.repository';
import { LoginController } from './login.controller';
import { LoginService } from './login.service';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { OtpCounters } from './otp-counters';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { PhoneChangeController } from './phone-change.controller';
import { Argon2PasswordHasher, PASSWORD_HASHER } from './password-hasher';
import { PasswordChangeController } from './password-change.controller';
import { PasswordChangeService } from './password-change.service';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { PHONE_VERIFIER, PhoneVerifierFactory } from './phone-verification';
import { SessionsController } from './sessions.controller';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';
import { TestMailboxRoute } from './test-mailbox.route';
import { UsersRepository } from './users.repository';

/**
 * Own authentication (Phase 6, spec §11.3 A1-A20): access tokens and their public keys
 * (API-100-51), sign-up and email verification (52), device sessions (56). Emails and texts go through the Phase 5 channel adapters (`ChannelSenders`).
 */
@Module({
  imports: [AuthenticationModule, AuditModule, RateLimitModule],
  controllers: [
    JwksController,
    SignupController,
    OtpController,
    LoginController,
    OAuthController,
    SessionsController,
    PasswordResetController,
    PasswordChangeController,
    PhoneChangeController,
  ],
  providers: [
    AccessTokenSigner,
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    ChannelSenders,
    AuthMessenger,
    AuthLimits,
    UsersRepository,
    AuthLinksRepository,
    SessionsRepository,
    SessionsService,
    SignupService,
    PhoneVerifierFactory,
    {
      provide: PHONE_VERIFIER,
      inject: [PhoneVerifierFactory],
      useFactory: (factory: PhoneVerifierFactory) => factory.create(),
    },
    OtpCounters,
    OtpService,
    LockoutRepository,
    LoginService,
    { provide: ID_TOKEN_VERIFIER, useClass: JoseIdTokenVerifier },
    OAuthService,
    PasswordResetService,
    PasswordChangeService,
    TestMailboxRoute,
  ],
  exports: [AccessTokenSigner, SessionsRepository],
})
export class AuthModule {}
