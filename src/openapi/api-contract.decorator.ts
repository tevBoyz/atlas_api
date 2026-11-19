import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

import type { ErrorCode } from '../common/errors/error-codes';

export const API_CONTRACT_METADATA = 'atlas:api-contract';

/**
 * A documented response with a body. `name` becomes the schema (and Dart class) name; required for a
 * body schema except an array, which is written inline (name its items with `componentSchema`).
 */
export interface ApiResponseContract {
  description: string;
  name?: string;
  schema?: z.ZodType;
}

/** What a route publishes in the OpenAPI document (API-100-12). */
export interface ApiContractOptions {
  /** Stable, camelCase: it names the generated Dart method. Never change it once released. */
  operationId: string;
  summary: string;
  tag: string;
  /** Path parameters. */
  params?: z.ZodObject;
  /** Query-string parameters. */
  query?: z.ZodObject;
  /** JSON request body, with the schema name it is published under. */
  body?: { name: string; schema: z.ZodType };
  /** Success (and other non-envelope) responses by HTTP status. */
  responses: Readonly<Record<number, ApiResponseContract>>;
  /** Domain errors of this operation. The envelope, 401, 429 and 5xx are added automatically. */
  errors?: readonly ErrorCode[];
}

/**
 * Declares the contract of a route. Every route of the app needs one: `npm run openapi:check` fails
 * otherwise. Auth, `Idempotency-Key` and rate-limit documentation come from the route's own
 * decorators, so they cannot drift from what the route does.
 */
export const ApiContract = (options: ApiContractOptions): MethodDecorator =>
  SetMetadata(API_CONTRACT_METADATA, options);
