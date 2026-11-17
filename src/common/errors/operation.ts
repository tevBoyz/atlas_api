import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';

import type { ErrorPrefix } from './error-codes';

export const OPERATION_METADATA = 'atlas:operation';

/**
 * Names the SQL operation a route replaces (its error prefix, spec §7), e.g.
 * `@Operation('invite_circle_member_by_phone')`. The exception filter uses it to turn the raw
 * trigger message `circle_full` into `<fn>:circle_full` (story API-100-05 AC3).
 */
export const Operation = (name: ErrorPrefix): MethodDecorator & ClassDecorator =>
  SetMetadata(OPERATION_METADATA, name);

const requestOperations = new WeakMap<object, ErrorPrefix>();

/** The operation recorded for this request (the Fastify request object), if any. */
export function getRequestOperation(request: object | undefined): ErrorPrefix | undefined {
  return request ? requestOperations.get(request) : undefined;
}

/** The `@Operation` of the handler (or its controller) in an execution context. */
export function operationOf(
  reflector: Reflector,
  context: ExecutionContext,
): ErrorPrefix | undefined {
  return reflector.getAllAndOverride<ErrorPrefix | undefined>(OPERATION_METADATA, [
    context.getHandler(),
    context.getClass(),
  ]);
}

/**
 * Records the handler's `@Operation` on the request so the exception filter (which has no access to
 * the handler) can read it. Runs before pipes and the handler, so validation and handler errors see it.
 * Guards run earlier: a guard needing the operation reads it with {@link operationOf}.
 */
@Injectable()
export class OperationContextInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const operation = operationOf(this.reflector, context);
      const request = context.switchToHttp().getRequest<object>();
      if (operation && request) requestOperations.set(request, operation);
    }
    return next.handle();
  }
}
