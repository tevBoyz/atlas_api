import { z } from 'zod';

import { API_VERSION } from '../app.constants';
import { REALTIME_CONTRACT } from '../realtime/realtime.contract';
import { type ErrorCode, parityCode } from '../common/errors/error-codes';
import { messageForCode } from '../common/errors/error-messages';
import { httpStatusForCode } from '../common/errors/http-status';
import type { ApiContractOptions, ApiResponseContract } from './api-contract.decorator';
import { componentNameOf } from './component-schema';
import type { DiscoveredRoute } from './route-discovery';
import { errorBodySchema, SHARED_ENUM_SCHEMAS } from './schemas';

type JsonObject = Record<string, unknown>;

const ERROR_ENVELOPE_REF = { $ref: '#/components/schemas/ErrorEnvelope' };
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;

export class OpenApiContractError extends Error {
  constructor(problems: readonly string[]) {
    super(`OpenAPI contract problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'OpenApiContractError';
  }
}

/** Every property name of a JSON schema must be snake_case (spec §11.2, §10.4). */
function nonSnakeCaseProperties(schema: unknown, path: string, problems: string[]): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => nonSnakeCaseProperties(item, `${path}[${index}]`, problems));
    return;
  }
  if (schema === null || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const [property, inner] of Object.entries(value as JsonObject)) {
        if (!SNAKE_CASE.test(property)) problems.push(`${path}: "${property}" is not snake_case`);
        nonSnakeCaseProperties(inner, `${path}.${property}`, problems);
      }
    } else {
      nonSnakeCaseProperties(value, `${path}.${key}`, problems);
    }
  }
}

/** Called for every {@link componentSchema} nested in a converted schema. */
type ComponentHandler = (name: string, schema: z.ZodType) => void;

/**
 * JSON Schema of `schema`. With `onComponent`, a nested schema published with
 * {@link componentSchema} becomes a `$ref` (the root itself is always written out).
 */
function jsonSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
  onComponent?: ComponentHandler,
): JsonObject {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    override: ({ zodSchema, jsonSchema: converted, path }) => {
      const name = onComponent && path.length > 0 ? componentNameOf(zodSchema) : undefined;
      if (!name || !onComponent) return;
      onComponent(name, zodSchema as unknown as z.ZodType);
      const target = converted as JsonObject;
      for (const key of Object.keys(target)) delete target[key];
      target.$ref = `#/components/schemas/${name}`;
    },
  }) as JsonObject;
  delete json.$schema;
  return json;
}

/** Recursively sorts object keys, so the output never depends on declaration order. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as JsonObject)[key])]),
  );
}

function errorResponse(description: string, codes: readonly ErrorCode[], headers?: JsonObject) {
  const [first] = codes;
  return {
    description,
    ...(headers ? { headers } : {}),
    content: {
      'application/json': {
        schema: ERROR_ENVELOPE_REF,
        example: { error: { code: first, message: messageForCode(first), details: {} } },
      },
    },
    'x-error-codes': [...codes].sort(),
  };
}

const RETRY_AFTER = {
  'Retry-After': {
    description: 'Seconds to wait before retrying.',
    schema: { type: 'integer', minimum: 0 },
  },
};

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad request',
  401: 'Missing, invalid or expired access token',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict',
  410: 'Gone',
  422: 'Invalid request',
  423: 'Locked',
  429: 'Too many requests',
  500: 'Unexpected error',
};

/** Errors every route of this kind can answer, derived from its decorators. */
function implicitErrors(route: DiscoveredRoute): ErrorCode[] {
  const codes: ErrorCode[] = ['internal:error'];
  if (!route.skipRateLimit) codes.push('rate_limit:exceeded');
  if (!route.isPublic && route.operation) {
    const code = parityCode(route.operation, 'not_authenticated');
    if (code) codes.push(code);
  }
  if (route.idempotency) {
    codes.push('idempotency:invalid_key', 'idempotency:key_mismatch', 'idempotency:in_progress');
    if (route.idempotency === 'required') codes.push('idempotency:key_required');
  }
  return codes;
}

function errorResponses(route: DiscoveredRoute, contract: ApiContractOptions): JsonObject {
  const byStatus = new Map<number, Set<ErrorCode>>();
  for (const code of [...implicitErrors(route), ...(contract.errors ?? [])]) {
    const status = httpStatusForCode(code);
    if (status === undefined) throw new OpenApiContractError([`${route.name}: unmapped ${code}`]);
    byStatus.set(status, (byStatus.get(status) ?? new Set<ErrorCode>()).add(code));
  }
  const responses: JsonObject = {};
  for (const [status, codes] of byStatus) {
    const retryable = status === 429 || codes.has('idempotency:in_progress');
    responses[String(status)] = errorResponse(
      STATUS_TEXT[status] ?? 'Error',
      [...codes].sort(),
      retryable ? RETRY_AFTER : undefined,
    );
  }
  return responses;
}

function parameters(route: DiscoveredRoute, contract: ApiContractOptions): JsonObject[] {
  const list: JsonObject[] = [];
  const add = (location: 'path' | 'query', schema: z.ZodObject | undefined) => {
    if (!schema) return;
    const json = jsonSchema(schema, 'input') as {
      properties?: Record<string, JsonObject>;
      required?: string[];
    };
    for (const [name, property] of Object.entries(json.properties ?? {})) {
      list.push({
        name,
        in: location,
        required: location === 'path' || (json.required ?? []).includes(name),
        schema: property,
      });
    }
  };
  add('path', contract.params);
  add('query', contract.query);
  for (const header of contract.headers ?? []) {
    list.push({
      name: header.name,
      in: 'header',
      required: header.required,
      description: header.description,
      schema: { type: 'string', format: header.format },
    });
  }
  if (route.idempotency) {
    list.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: route.idempotency === 'required',
      description: 'UUID chosen by the client. A retry with the same key replays the first result.',
      schema: { type: 'string', format: 'uuid' },
    });
  }
  return list;
}

function buildOperation(
  route: DiscoveredRoute,
  contract: ApiContractOptions,
  schemas: Map<string, JsonObject>,
  problems: string[],
): JsonObject {
  const register = (name: string, schema: z.ZodType, io: 'input' | 'output') => {
    const json = jsonSchema(schema, io, (component, inner) => register(component, inner, io));
    nonSnakeCaseProperties(json, name, problems);
    const existing = schemas.get(name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(json)) {
      problems.push(`${route.name}: two different schemas are named ${name}`);
    }
    schemas.set(name, json);
    return { $ref: `#/components/schemas/${name}` };
  };

  /** A named schema is a component; an unnamed array is written inline (its items carry the name). */
  const responseSchema = (status: string, response: ApiResponseContract) => {
    if (!response.schema) return undefined;
    if (response.name) return register(response.name, response.schema, 'output');
    if (response.schema instanceof z.ZodArray) {
      const json = jsonSchema(response.schema, 'output', (component, inner) =>
        register(component, inner, 'output'),
      );
      nonSnakeCaseProperties(json, `${route.name} ${status}`, problems);
      return json;
    }
    problems.push(`${route.name}: the ${status} response schema needs a name`);
    return undefined;
  };

  const responses: JsonObject = errorResponses(route, contract);
  for (const [status, response] of Object.entries(contract.responses)) {
    const schema = responseSchema(status, response);
    if (response.schema && !schema) continue;
    responses[status] = {
      description: response.description,
      ...(schema ? { content: { 'application/json': { schema } } } : {}),
    };
  }

  const params = parameters(route, contract);
  return {
    operationId: contract.operationId,
    summary: contract.summary,
    tags: [contract.tag],
    security: route.isPublic ? [] : [{ bearerAuth: [] }],
    ...(params.length > 0 ? { parameters: params } : {}),
    ...(contract.body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: register(contract.body.name, contract.body.schema, 'input'),
              },
            },
          },
        }
      : {}),
    responses,
  };
}

/**
 * The OpenAPI 3.1 document of the given routes (API-100-12). A pure function of the code: no clock,
 * no environment, no data store, and sorted keys, so regenerating it is byte-stable on any machine.
 * Throws {@link OpenApiContractError} when a route breaks the contract rules.
 */
export function buildOpenApiDocument(routes: readonly DiscoveredRoute[]): JsonObject {
  const problems: string[] = [];
  const paths: Record<string, JsonObject> = {};
  const schemas = new Map<string, JsonObject>();
  const operationIds = new Map<string, string>();

  for (const route of routes) {
    const { contract } = route;
    if (!contract) {
      problems.push(`${route.name}: route without @ApiContract()`);
      continue;
    }
    if (!CAMEL_CASE.test(contract.operationId)) {
      problems.push(`${route.name}: operationId "${contract.operationId}" is not camelCase`);
    }
    const other = operationIds.get(contract.operationId);
    if (other) problems.push(`${route.name}: operationId already used by ${other}`);
    operationIds.set(contract.operationId, route.name);
    paths[route.path] = {
      ...paths[route.path],
      [route.method]: buildOperation(route, contract, schemas, problems),
    };
  }
  if (problems.length > 0) throw new OpenApiContractError(problems);

  const enums = Object.entries(SHARED_ENUM_SCHEMAS).map(([name, schema]): [string, JsonObject] => [
    name,
    jsonSchema(schema, 'output'),
  ]);
  return sortKeys({
    openapi: '3.1.0',
    info: {
      title: 'Atlas API',
      version: API_VERSION,
      description:
        'Atlas backend API. JSON properties are snake_case. Every non-2xx response uses the error envelope; `error.code` keeps the `fn:code` strings of the original SQL functions.',
    },
    servers: [{ url: '/' }],
    paths,
    // Socket.IO events (API-100-39 to 43): not REST, published as data for the client authors.
    'x-realtime': REALTIME_CONTRACT,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        // A named object, so clients do not generate a class called `Error`.
        ErrorBody: jsonSchema(errorBodySchema, 'output'),
        ErrorEnvelope: {
          type: 'object',
          description: 'The body of every non-2xx response (spec §11.2).',
          properties: { error: { $ref: '#/components/schemas/ErrorBody' } },
          required: ['error'],
        },
        ...Object.fromEntries(enums),
        ...Object.fromEntries(schemas),
      },
    },
  }) as JsonObject;
}

/** The exact bytes of `openapi.json`: LF line endings and a final newline. */
export function serializeOpenApiDocument(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
