import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger as PinoLogger } from 'pino';

import { reportError } from '../../observability/error-reporter';
import { requestLogger } from '../../observability/http-hooks';
import { ROOT_LOGGER } from '../../observability/logger';
import { domainErrorFromDatabase } from './database-error';
import type { ErrorCode, ErrorPrefix } from './error-codes';
import { messageForCode } from './error-messages';
import { DomainError, type ErrorDetails } from './domain-error';
import { genericCodeForStatus } from './http-status';
import { getRequestOperation } from './operation';

/** The only error body the API sends (spec §11.2, story API-100-05 AC1). */
export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details: ErrorDetails };
}

interface ResolvedError {
  status: number;
  code: ErrorCode;
  details: ErrorDetails;
  retryAfterSeconds?: number;
  /** True for anything not deliberately raised: logged at error level and reported (AC5). */
  unexpected: boolean;
}

const INTERNAL: Omit<ResolvedError, 'unexpected'> = {
  status: 500,
  code: 'internal:error',
  details: {},
};

/** A 4xx status carried by a non-Nest error (e.g. a Fastify/body-parser error Nest left unmapped). */
function clientStatusOf(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

function fromDomainError(error: DomainError): ResolvedError {
  return {
    status: error.status,
    code: error.code,
    details: error.details,
    retryAfterSeconds: error.retryAfterSeconds,
    unexpected: false,
  };
}

function fromClientStatus(status: number): ResolvedError {
  // Framework 4xx (unknown route, unreadable JSON, body too large, wrong content type, ...): a fixed
  // generic code and message. The framework's own message is dropped (it can echo the URL).
  return { status, code: genericCodeForStatus(status), details: {}, unexpected: false };
}

/** Maps any thrown value to the envelope fields (exported for unit tests). */
export function resolveError(
  exception: unknown,
  operation: ErrorPrefix | undefined,
): ResolvedError {
  if (exception instanceof DomainError) return fromDomainError(exception);

  const fromDatabase = domainErrorFromDatabase(exception, operation);
  if (fromDatabase) return fromDomainError(fromDatabase);

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return status >= 400 && status < 500
      ? fromClientStatus(status)
      : { ...INTERNAL, unexpected: true };
  }

  const clientStatus = clientStatusOf(exception);
  if (clientStatus !== undefined) return fromClientStatus(clientStatus);

  return { ...INTERNAL, unexpected: true };
}

/**
 * Global exception filter (story API-100-05). Every non-2xx response, including Nest's and
 * Fastify's own (unknown route, body parse errors, payload too large), leaves through here as the
 * envelope `{"error": {"code", "message", "details"}}`. Unexpected errors become 500
 * `internal:error` with no stack or SQL in the body; they are logged with the request id and
 * reported to Sentry (when enabled).
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const operation = getRequestOperation(request);
    const resolved = resolveError(exception, operation);

    if (resolved.unexpected) {
      const context = { method: request.method, route: request.routeOptions?.url, operation };
      // The request logger is bound to request_id; the error is scrubbed by the logger (no PII).
      requestLogger(request, this.logger).error({ ...context, err: exception }, 'unexpected error');
      reportError(exception, { ...context, request_id: request.id });
    }

    if (reply.sent) return;

    const body: ErrorEnvelope = {
      error: {
        code: resolved.code,
        message: messageForCode(resolved.code),
        details: resolved.details,
      },
    };
    if (resolved.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(Math.max(0, Math.ceil(resolved.retryAfterSeconds))));
    }
    void reply.status(resolved.status).header('content-type', 'application/json; charset=utf-8');
    void reply.send(body);
  }
}
