import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import { requestLogger } from '../../observability/http-hooks';
import { ROOT_LOGGER } from '../../observability/logger';
import { setRequestUser } from '../auth/authenticated-user';
import { bearerToken } from '../auth/bearer';
import { TOKEN_VERIFIER, TokenRejectedError, type TokenVerifier } from '../auth/token-verifier';
import { DomainError } from '../errors/domain-error';
import { type ErrorCode, parityCode } from '../errors/error-codes';
import { operationOf } from '../errors/operation';
import { isPublicRoute } from './route-access';

/**
 * Global authentication guard (API-100-08). Every route needs `Authorization: Bearer <jwt>` unless
 * it is `@Public()` (AC1). The token is checked by the {@link TokenVerifier} (AC2, AC3, AC5) and
 * the caller is recorded for `@CurrentUser()`.
 *
 * Missing, malformed, invalid or expired token → 401 with the route's parity code
 * `<fn>:not_authenticated` from its `@Operation('<fn>')` (AC4). Every non-public route declares
 * one: the route contract check fails the boot otherwise (`route-contract.ts`).
 *
 * The guard reads no table: `auth.users` / `profiles` checks belong to each operation.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (isPublicRoute(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const operation = operationOf(this.reflector, context);
    // Unreachable once booted (the route contract check requires an operation); kept as a 401.
    const code: ErrorCode =
      (operation && parityCode(operation, 'not_authenticated')) || 'http:unauthorized';

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      this.logRejection(
        request,
        operation,
        request.headers.authorization ? 'malformed' : 'missing',
      );
      throw new DomainError(code);
    }

    try {
      setRequestUser(request, await this.verifier.verify(token));
      return true;
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        this.logRejection(request, operation, error.reason);
        throw new DomainError(code);
      }
      // The token could not be checked (e.g. JWKS unreachable): 500, never a sign-out.
      throw error;
    }
  }

  private logRejection(request: FastifyRequest, operation: string | undefined, reason: string) {
    requestLogger(request, this.logger).debug({ operation, reason }, 'access token rejected');
  }
}
