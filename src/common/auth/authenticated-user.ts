import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/**
 * The verified caller of an authenticated route (API-100-08 AC3). Built only from the access
 * token's claims: the guard never reads `auth.users` or `profiles` (each operation checks what it
 * needs, e.g. `profile_not_found`).
 *
 * `email` / `phone` are the token's claims as issued (null when absent or empty). They are NOT
 * authorization inputs: the SQL functions read the Auth row (e.g. `_auth_user_phone`), so parity
 * code must do the same.
 */
export interface AuthenticatedUser {
  /** `sub`: the user id (auth.users.id), lowercase uuid. */
  readonly id: string;
  /** Who issued the token. Own tokens (API-100-51) add `'atlas'`. */
  readonly issuer: 'supabase';
  /** `session_id` claim when present (Supabase Auth session), else null. */
  readonly sessionId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

const requestUsers = new WeakMap<object, AuthenticatedUser>();

/** Records the verified caller on the request (the auth guard does this). */
export function setRequestUser(request: object, user: AuthenticatedUser): void {
  requestUsers.set(request, user);
}

/** The verified caller of this request (the Fastify request object), if any. */
export function getRequestUser(request: object | undefined): AuthenticatedUser | undefined {
  return request ? requestUsers.get(request) : undefined;
}

/** Thrown when a handler asks for the caller on a route without one (a `@Public()` route). */
export class NoAuthenticatedUserError extends Error {
  constructor() {
    super('@CurrentUser() used on a route without an authenticated caller (is it @Public()?)');
    this.name = 'NoAuthenticatedUserError';
  }
}

/** The caller from an execution context; throws (500) when there is none. */
export function currentUserOf(context: ExecutionContext): AuthenticatedUser {
  const user = getRequestUser(context.switchToHttp().getRequest<object>());
  if (!user) throw new NoAuthenticatedUserError();
  return user;
}

/**
 * `@CurrentUser() user: AuthenticatedUser` — the verified caller of an authenticated route.
 * A programming error (500) on a `@Public()` route, where there is no caller.
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  currentUserOf(context),
);
