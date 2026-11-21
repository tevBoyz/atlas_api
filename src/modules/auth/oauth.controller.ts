import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';

import { Public } from '../../common/guards/route-access';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireJsonObject } from '../incidents/incident-input';
import { INSTALLATION_ID_HEADER } from '../notifications/device-input';
import { deviceFrom, idTokenFrom, optionalInstallationId, optionalText } from './auth-input';
import { SIGN_IN_LIMIT } from './auth-limits';
import {
  appleSignInRequestSchema,
  googleSignInRequestSchema,
  INSTALLATION_ID_HEADER_OPTIONAL,
  oauthSessionSchema,
} from './auth.schemas';
import { type OAuthSessionJson, OAuthService } from './oauth.service';
import { clientContext } from './sessions.service';

const ERRORS = [
  'validation:invalid_request',
  'auth:invalid_device',
  'auth:oauth_invalid_token',
  'auth:identity_conflict',
  'auth:provider_disabled',
  'auth:provider_unavailable',
  'auth:user_disabled',
] as const;

/** Google and Apple sign-in (API-100-55, spec §11.3 A9/A10). Public, limited per IP. */
@Controller('auth/oauth')
@Public()
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  /** A9. `access_token` is accepted and not used (the ID token is what is verified). */
  @Post('google')
  @HttpCode(200)
  @RateLimit(SIGN_IN_LIMIT)
  @ApiContract({
    operationId: 'signInWithGoogle',
    summary: 'Sign in with a Google ID token',
    tag: 'auth',
    headers: [INSTALLATION_ID_HEADER_OPTIONAL],
    body: { name: 'GoogleSignInRequest', schema: googleSignInRequestSchema },
    responses: {
      200: {
        description:
          'A new session; `is_new_user` when this created the account. An existing account with the same email is linked only when Google says the email is verified (D6).',
        name: 'OAuthSession',
        schema: oauthSessionSchema,
      },
    },
    errors: [...ERRORS],
  })
  google(
    @Body() body: unknown,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
    @Headers('user-agent') userAgent: unknown,
  ): Promise<OAuthSessionJson> {
    const input = requireJsonObject(body);
    const idToken = idTokenFrom(input.id_token);
    optionalText(input.access_token, 'access_token', 8192);
    const device = deviceFrom(input.device, optionalInstallationId(installationId));
    return this.oauth.signIn(
      'google',
      idToken,
      { nonce: null, fullName: null },
      device,
      clientContext(userAgent),
    );
  }

  /** A10. Disabled by default (503 `auth:provider_disabled`). */
  @Post('apple')
  @HttpCode(200)
  @RateLimit(SIGN_IN_LIMIT)
  @ApiContract({
    operationId: 'signInWithApple',
    summary: 'Sign in with an Apple ID token (off until enabled: 503 auth:provider_disabled)',
    tag: 'auth',
    headers: [INSTALLATION_ID_HEADER_OPTIONAL],
    body: { name: 'AppleSignInRequest', schema: appleSignInRequestSchema },
    responses: {
      200: { description: 'A new session.', name: 'OAuthSession', schema: oauthSessionSchema },
    },
    errors: [...ERRORS],
  })
  apple(
    @Body() body: unknown,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
    @Headers('user-agent') userAgent: unknown,
  ): Promise<OAuthSessionJson> {
    const input = requireJsonObject(body);
    const idToken = idTokenFrom(input.id_token);
    const nonce = optionalText(input.nonce, 'nonce', 256);
    const fullName = optionalText(input.full_name, 'full_name', 100);
    const device = deviceFrom(input.device, optionalInstallationId(installationId));
    return this.oauth.signIn(
      'apple',
      idToken,
      { nonce, fullName },
      device,
      clientContext(userAgent),
    );
  }
}
