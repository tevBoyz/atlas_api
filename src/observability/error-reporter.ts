/**
 * Indirection between the app and the error-reporting backend (Sentry), so app code never imports
 * `@sentry/node` and nothing is loaded or sent when `SENTRY_DSN` is unset (story API-100-06 AC4).
 * The reporter is installed at boot by `observability/instrument.ts` only when Sentry is enabled.
 */

/** Non-personal context attached to a report. */
export interface ErrorReportContext {
  request_id?: string;
  /** Route template (e.g. `/v1/incidents/:id`), never the raw URL. */
  route?: string;
  method?: string;
  operation?: string;
}

export type ErrorReporter = (error: unknown, context: ErrorReportContext) => void;

let reporter: ErrorReporter | undefined;

/** Installs (or with `undefined`, removes) the reporter. */
export function setErrorReporter(next: ErrorReporter | undefined): void {
  reporter = next;
}

export function isErrorReportingEnabled(): boolean {
  return reporter !== undefined;
}

/** Reports an unexpected error. Never throws: a reporting failure must not change the response. */
export function reportError(error: unknown, context: ErrorReportContext = {}): void {
  if (!reporter) return;
  try {
    reporter(error, context);
  } catch {
    // Reporting is best effort.
  }
}
