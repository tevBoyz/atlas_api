import type { Config } from '../config/config.schema';
import { resolveRelease } from './release';
import type { SentryHandle, SentryOptions } from './sentry';
import type { TracingHandle, TracingOptions } from './tracing';

/**
 * Starts tracing and error reporting before the app is loaded (story API-100-06 AC3, AC4).
 * Each is completely off when its setting is unset: its module (and SDK) is not even loaded.
 */

export type ObservabilityConfig = Pick<
  Config,
  'NODE_ENV' | 'OTEL_EXPORTER_OTLP_ENDPOINT' | 'SENTRY_DSN' | 'GIT_COMMIT'
>;

export interface ObservabilityLoaders {
  tracing: () => { startTracing(options: TracingOptions): TracingHandle };
  sentry: () => { initSentry(options: SentryOptions): SentryHandle };
}

/* eslint-disable @typescript-eslint/no-require-imports -- lazy: SDKs load only when enabled */
const defaultLoaders: ObservabilityLoaders = {
  tracing: () => require('./tracing') as typeof import('./tracing'),
  sentry: () => require('./sentry') as typeof import('./sentry'),
};
/* eslint-enable @typescript-eslint/no-require-imports */

export interface ObservabilityState {
  release?: string;
  tracing?: TracingHandle;
  sentry?: SentryHandle;
}

let active: ObservabilityState = {};

export function startObservability(
  config: ObservabilityConfig,
  loaders: ObservabilityLoaders = defaultLoaders,
  buildInfoFile?: string,
): ObservabilityState {
  const release = resolveRelease(config.GIT_COMMIT, buildInfoFile);
  const state: ObservabilityState = { release };
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    state.tracing = loaders.tracing().startTracing({
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
      release,
      environment: config.NODE_ENV,
    });
  }
  if (config.SENTRY_DSN) {
    state.sentry = loaders.sentry().initSentry({
      dsn: config.SENTRY_DSN,
      release,
      environment: config.NODE_ENV,
    });
  }
  active = state;
  return state;
}

/** Flushes and stops whatever {@link startObservability} started. Safe to call more than once. */
export async function shutdownObservability(): Promise<void> {
  const { tracing, sentry } = active;
  active = {};
  await Promise.allSettled([tracing?.shutdown(), sentry?.close()]);
}
