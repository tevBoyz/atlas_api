import { Injectable, type OnModuleInit } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { type ErrorPrefix, parityCode } from '../errors/error-codes';
import { OPERATION_METADATA } from '../errors/operation';
import { IDEMPOTENCY_METADATA, type IdempotencyMode } from '../idempotency/idempotent.decorator';
import { RATE_LIMIT_METADATA, type RateLimitRule } from '../rate-limit/rate-limit.decorator';
import { type RateLimitScope, scopeOfRule } from '../rate-limit/rate-limit.policies';
import { IS_PUBLIC_KEY, SKIP_RATE_LIMIT_KEY } from './route-access';

/** What the contract check needs to know about one route handler. */
export interface RouteDescriptor {
  /** `Controller.method`, for the error message. */
  name: string;
  isPublic: boolean;
  operation?: ErrorPrefix;
  idempotency?: IdempotencyMode;
  /** Scope of the route's `@RateLimit()`, when it declares one. */
  rateLimitScope?: RateLimitScope;
  skipRateLimit?: boolean;
}

/**
 * The rules every route must follow (API-100-08 AC4, API-100-10):
 * - a non-public route declares `@Operation('<fn>')` whose catalogue lists `not_authenticated`,
 *   so a 401 always carries the route's parity code `<fn>:not_authenticated`;
 * - an `@Idempotent()` route is authenticated (keys are stored per user);
 * - a `@RateLimit()` keyed by user is on an authenticated route, and never with `@SkipRateLimit()`.
 * Returns one line per broken rule (empty = all good).
 */
export function routeContractProblems(routes: readonly RouteDescriptor[]): string[] {
  const problems: string[] = [];
  for (const route of routes) {
    if (!route.isPublic) {
      if (!route.operation) {
        problems.push(`${route.name}: authenticated route without @Operation('<fn>')`);
      } else if (!parityCode(route.operation, 'not_authenticated')) {
        problems.push(
          `${route.name}: @Operation('${route.operation}') has no ${route.operation}:not_authenticated code in the catalogue`,
        );
      }
    }
    if (route.idempotency && route.isPublic) {
      problems.push(`${route.name}: @Idempotent() on a @Public() route (keys are per user)`);
    }
    if (route.rateLimitScope && route.rateLimitScope !== 'ip' && route.isPublic) {
      problems.push(
        `${route.name}: per-user @RateLimit() on a @Public() route (no user to key on)`,
      );
    }
    if (route.rateLimitScope && route.skipRateLimit) {
      problems.push(`${route.name}: @RateLimit() together with @SkipRateLimit()`);
    }
  }
  return problems;
}

/** The app does not follow the route contract: it must not start. */
export class RouteContractError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Route contract violated:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'RouteContractError';
  }
}

/**
 * Fails the boot (`app.init()` / `listen()`) when any registered route breaks the route contract
 * (see {@link routeContractProblems}). Runs over every controller of the app, including test-only
 * ones, so a forgotten `@Operation` can never reach production as a generic 401.
 */
@Injectable()
export class RouteContractCheck implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const problems = routeContractProblems(this.describeRoutes());
    if (problems.length > 0) throw new RouteContractError(problems);
  }

  /** Every route handler of every controller. */
  describeRoutes(): RouteDescriptor[] {
    const routes: RouteDescriptor[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      const controller = wrapper.metatype as (abstract new (...args: never[]) => unknown) | null;
      if (!instance || !controller) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method];
        if (typeof handler !== 'function') continue;
        const isRoute =
          Reflect.getMetadata(PATH_METADATA, handler) !== undefined &&
          Reflect.getMetadata(METHOD_METADATA, handler) !== undefined;
        if (!isRoute) continue;
        const targets = [handler, controller];
        routes.push({
          name: `${controller.name}.${method}`,
          isPublic: this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true,
          operation: this.reflector.getAllAndOverride<ErrorPrefix | undefined>(
            OPERATION_METADATA,
            targets,
          ),
          idempotency: this.reflector.getAllAndOverride<IdempotencyMode | undefined>(
            IDEMPOTENCY_METADATA,
            targets,
          ),
          rateLimitScope: scopeOfRule(
            this.reflector.getAllAndOverride<RateLimitRule | undefined>(
              RATE_LIMIT_METADATA,
              targets,
            ),
          ),
          skipRateLimit:
            this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, targets) === true ||
            undefined,
        });
      }
    }
    return routes;
  }
}
