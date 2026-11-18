import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { API_PREFIX, UNPREFIXED_ROUTES } from '../app.constants';
import type { ErrorPrefix } from '../common/errors/error-codes';
import { OPERATION_METADATA } from '../common/errors/operation';
import { IS_PUBLIC_KEY, SKIP_RATE_LIMIT_KEY } from '../common/guards/route-access';
import {
  IDEMPOTENCY_METADATA,
  type IdempotencyMode,
} from '../common/idempotency/idempotent.decorator';
import { API_CONTRACT_METADATA, type ApiContractOptions } from './api-contract.decorator';

/** One HTTP route, read from decorators only: no provider is created, no store is contacted. */
export interface DiscoveredRoute {
  /** `Controller.method`, for error messages. */
  name: string;
  method: string;
  /** OpenAPI path, e.g. `/v1/incidents/{id}`. */
  path: string;
  isPublic: boolean;
  skipRateLimit: boolean;
  operation?: ErrorPrefix;
  idempotency?: IdempotencyMode;
  contract?: ApiContractOptions;
}

type ModuleLike = Type<unknown> | { module?: Type<unknown>; forwardRef?: () => ModuleLike };

/** Every controller reachable from a root module, following static and dynamic imports. */
export function collectControllers(root: Type<unknown>): Type<unknown>[] {
  const controllers = new Set<Type<unknown>>();
  const seen = new Set<unknown>();

  const visit = (entry: ModuleLike | undefined): void => {
    if (!entry || seen.has(entry)) return;
    seen.add(entry);
    if (typeof entry !== 'function') {
      if (entry.forwardRef) return visit(entry.forwardRef());
      const dynamic = entry as {
        module?: Type<unknown>;
        imports?: ModuleLike[];
        controllers?: Type<unknown>[];
      };
      dynamic.controllers?.forEach((controller) => controllers.add(controller));
      dynamic.imports?.forEach(visit);
      return visit(dynamic.module);
    }
    const declared = (Reflect.getMetadata('controllers', entry) ?? []) as Type<unknown>[];
    declared.forEach((controller) => controllers.add(controller));
    ((Reflect.getMetadata('imports', entry) ?? []) as ModuleLike[]).forEach(visit);
  };

  visit(root);
  return [...controllers];
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
    .join('/');
  return `/${joined}`;
}

function routePath(controllerPath: string, handlerPath: string): string {
  const path = joinPath(controllerPath, handlerPath);
  return UNPREFIXED_ROUTES.includes(path.slice(1)) ? path : joinPath(API_PREFIX, path);
}

/** Handler metadata wins over the controller's, as in Nest's `getAllAndOverride`. */
function metadataOf<T>(key: string, handler: object, controller: object): T | undefined {
  return (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller)) as
    T | undefined;
}

/** The routes of the given controllers. */
export function discoverRoutes(controllers: readonly Type<unknown>[]): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    const controllerPath = (Reflect.getMetadata(PATH_METADATA, controller) ?? '') as string;
    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[methodName];
      if (methodName === 'constructor' || typeof handler !== 'function') continue;
      const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (handlerPath === undefined || method === undefined) continue;
      routes.push({
        name: `${controller.name}.${methodName}`,
        method: RequestMethod[method].toLowerCase(),
        path: routePath(controllerPath, handlerPath),
        isPublic: metadataOf<boolean>(IS_PUBLIC_KEY, handler, controller) === true,
        skipRateLimit: metadataOf<boolean>(SKIP_RATE_LIMIT_KEY, handler, controller) === true,
        operation: metadataOf<ErrorPrefix>(OPERATION_METADATA, handler, controller),
        idempotency: metadataOf<IdempotencyMode>(IDEMPOTENCY_METADATA, handler, controller),
        contract: Reflect.getMetadata(API_CONTRACT_METADATA, handler) as
          ApiContractOptions | undefined,
      });
    }
  }
  return routes;
}
