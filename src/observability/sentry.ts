import * as Sentry from '@sentry/node';

import { type ErrorReportContext, setErrorReporter } from './error-reporter';
import { scrub } from './scrubber';

/**
 * Sentry error reporting (story API-100-06 AC4). Only loaded when SENTRY_DSN is set (see
 * `instrument.ts`). Reports unexpected errors only (the 500s of the exception filter, uncaught
 * exceptions, unhandled rejections), scrubbed with the same rules as the logs. No tracing,
 * no request bodies, headers, cookies, query strings or user data are sent.
 */

export interface SentryOptions {
  dsn: string;
  release?: string;
  environment: string;
}

export interface SentryHandle {
  close(timeoutMs?: number): Promise<boolean>;
}

/** Default integrations that would attach request data or local values to events. */
const EXCLUDED_INTEGRATIONS = new Set(['RequestData', 'Console', 'LocalVariables']);

type SentryEvent = Sentry.ErrorEvent;

/** `beforeSend`: scrub the whole event, keep only the request method, drop user data. */
export function scrubSentryEvent(event: SentryEvent): SentryEvent {
  const scrubbed = scrub(event);
  if (scrubbed.request) scrubbed.request = { method: scrubbed.request.method };
  if (scrubbed.user) scrubbed.user = scrubbed.user.id ? { id: scrubbed.user.id } : undefined;
  return scrubbed;
}

/** `beforeBreadcrumb`: scrubbed; console breadcrumbs dropped (logs already hold them). */
export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  return breadcrumb.category === 'console' ? null : scrub(breadcrumb);
}

/**
 * Initializes Sentry and installs it as the app's error reporter.
 * @param overrides test-only options (e.g. a fake `transport` so nothing leaves the process).
 */
export function initSentry(
  options: SentryOptions,
  overrides: Partial<Sentry.NodeOptions> = {},
): SentryHandle {
  Sentry.init({
    dsn: options.dsn,
    release: options.release,
    environment: options.environment,
    // Collect nothing about requests, users, queries or local variables (beforeSend scrubs anyway).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    includeLocalVariables: false,
    integrations: (defaults) => defaults.filter((i) => !EXCLUDED_INTEGRATIONS.has(i.name)),
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    ...overrides,
  });

  setErrorReporter((error: unknown, context: ErrorReportContext) => {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        if (typeof value === 'string') scope.setTag(key, value);
      }
      Sentry.captureException(error);
    });
  });

  return {
    close: async (timeoutMs = 2000) => {
      setErrorReporter(undefined);
      return Sentry.close(timeoutMs);
    },
  };
}
