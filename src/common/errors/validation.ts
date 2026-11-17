import { Body, Injectable, Param, type PipeTransform, Query } from '@nestjs/common';
import type { z } from 'zod';

import type { ErrorCode } from './error-codes';
import { DomainError } from './domain-error';

/**
 * Which parity code a validation failure maps to (story API-100-05 AC4).
 * - `fields`: top-level request field → code, e.g.
 *   `{ location_source: 'attach_incident_location:invalid_source' }`.
 * - `fallback`: code for any other failure (including a body that is not an object at all),
 *   e.g. `invite_circle_members_by_phone:invalid_invites`.
 * Anything not covered → `validation:invalid_request`.
 */
export interface ValidationCodes {
  fields?: Readonly<Record<string, ErrorCode>>;
  fallback?: ErrorCode;
}

/** Where the validated value comes from; names the field when the whole value is wrong. */
export type ValidationSource = 'body' | 'query' | 'param';

/**
 * Validates a request value with a zod schema. On failure throws a {@link DomainError} for the FIRST
 * issue only (zod reports issues in schema order: declare fields in the SQL function's check order
 * so the first failing check wins). Status comes from the §11.2 table (422 for `invalid_*`).
 * `details` is `{ field }` only: the rejected value is never echoed.
 */
@Injectable()
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  /**
   * @param rootField `details.field` (and `fields` lookup key) when the whole value fails, e.g. the
   *   path parameter name. Defaults to the source (`body`, `query`, `param`).
   */
  constructor(
    private readonly schema: S,
    private readonly codes: ValidationCodes = {},
    private readonly source: ValidationSource = 'body',
    private readonly rootField?: string,
  ) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const path = result.error.issues[0]?.path ?? [];
    const topLevel = path.length > 0 ? String(path[0]) : this.rootField;
    const field = path.length > 0 ? path.map(String).join('.') : (this.rootField ?? this.source);
    const code =
      (topLevel !== undefined ? this.codes.fields?.[topLevel] : undefined) ??
      this.codes.fallback ??
      'validation:invalid_request';
    throw new DomainError(code, { details: { field } });
  }
}

/** `@ZodBody(schema, codes?)`: the validated request body. */
export const ZodBody = <S extends z.ZodType>(
  schema: S,
  codes?: ValidationCodes,
): ParameterDecorator => Body(new ZodValidationPipe(schema, codes, 'body'));

/** `@ZodQuery(schema, codes?)`: the validated query-string object. */
export const ZodQuery = <S extends z.ZodType>(
  schema: S,
  codes?: ValidationCodes,
): ParameterDecorator => Query(new ZodValidationPipe(schema, codes, 'query'));

/** `@ZodParam('id', schema, codes?)`: one validated path parameter (`details.field` = its name). */
export const ZodParam = <S extends z.ZodType>(
  name: string,
  schema: S,
  codes?: ValidationCodes,
): ParameterDecorator => Param(name, new ZodValidationPipe(schema, codes, 'param', name));
