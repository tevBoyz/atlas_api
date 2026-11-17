import type { IncomingMessage } from 'node:http';

import { FastifyOtelInstrumentation } from '@fastify/otel';
import type { Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import { scrubString } from './scrubber';

/**
 * OpenTelemetry tracing (story API-100-06 AC3). This module is only loaded when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (see `instrument.ts`): with no endpoint no SDK is created.
 *
 * Instrumented: HTTP (incoming and outgoing), Fastify routes (`@fastify/otel`, the maintained
 * successor of the deprecated `@opentelemetry/instrumentation-fastify`), Postgres (`pg`) and Redis
 * (`ioredis`, the client BullMQ uses). BullMQ itself is traced through its own `telemetry` option
 * (`bullmq-otel`), wired by the jobs story when queues exist.
 */

export interface TracingOptions {
  endpoint: string;
  release?: string;
  environment: string;
}

export interface TracingHandle {
  shutdown(): Promise<void>;
}

/** OTLP/HTTP traces URL for a base endpoint (`http://collector:4318` → `.../v1/traces`). */
export function tracesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

/** Span attributes that can carry the raw URL (old and stable HTTP semantic conventions). */
const URL_ATTRIBUTES = ['http.target', 'http.url', 'url.full', 'url.path'] as const;

/** Raw path without its query string, with tokens and personal data scrubbed. */
export function safePath(url: string | undefined): string {
  return scrubString((url ?? '').split('?')[0] ?? '');
}

/** Removes the query string and scrubs the path of incoming request spans (no personal data in traces). */
function scrubIncomingSpan(span: Span, request: unknown): void {
  const raw = request as Partial<IncomingMessage>;
  if (typeof raw.url !== 'string' || raw.headers === undefined) return;
  const path = safePath(raw.url);
  for (const attribute of URL_ATTRIBUTES) span.setAttribute(attribute, path);
  span.setAttribute('url.query', '');
}

export function buildInstrumentations() {
  return [
    new HttpInstrumentation({
      requestHook: scrubIncomingSpan,
      applyCustomAttributesOnSpan: (span, request) => scrubIncomingSpan(span, request),
    }),
    new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    // Statements only, never parameter values (the default; stated for clarity).
    new PgInstrumentation({ enhancedDatabaseReporting: false }),
    // Command name only: Redis arguments can hold keys built from user data.
    new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
  ];
}

/** Starts the OpenTelemetry Node SDK exporting traces over OTLP/HTTP. */
export function startTracing(options: TracingOptions): TracingHandle {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'atlas-api',
      [ATTR_SERVICE_VERSION]: options.release ?? 'unknown',
      'deployment.environment.name': options.environment,
    }),
    traceExporter: new OTLPTraceExporter({ url: tracesUrl(options.endpoint) }),
    instrumentations: buildInstrumentations(),
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
