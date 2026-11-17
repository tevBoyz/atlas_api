import { join } from 'node:path';

import { isErrorReportingEnabled } from './error-reporter';
import {
  type ObservabilityConfig,
  type ObservabilityLoaders,
  shutdownObservability,
  startObservability,
} from './instrument';

const NO_BUILD_INFO = join(__dirname, 'does-not-exist', 'build-info.json');

function fakeLoaders() {
  const tracingShutdown = jest.fn(() => Promise.resolve());
  const sentryClose = jest.fn(() => Promise.resolve(true));
  const startTracing = jest.fn(() => ({ shutdown: tracingShutdown }));
  const initSentry = jest.fn(() => ({ close: sentryClose }));
  const loadTracing = jest.fn(() => ({ startTracing }));
  const loadSentry = jest.fn(() => ({ initSentry }));
  const loaders: ObservabilityLoaders = { tracing: loadTracing, sentry: loadSentry };
  return {
    loaders,
    loadTracing,
    loadSentry,
    startTracing,
    initSentry,
    tracingShutdown,
    sentryClose,
  };
}

const BASE: ObservabilityConfig = { NODE_ENV: 'test' };

describe('startObservability (API-100-06 AC3, AC4)', () => {
  afterEach(async () => {
    await shutdownObservability();
  });

  it('starts nothing, and loads no SDK module, when neither setting is set', () => {
    const fake = fakeLoaders();
    const state = startObservability(BASE, fake.loaders, NO_BUILD_INFO);
    expect(fake.loadTracing).not.toHaveBeenCalled();
    expect(fake.loadSentry).not.toHaveBeenCalled();
    expect(state.tracing).toBeUndefined();
    expect(state.sentry).toBeUndefined();
    expect(isErrorReportingEnabled()).toBe(false);
  });

  it('starts OpenTelemetry only, with the endpoint and release, when the endpoint is set', () => {
    const fake = fakeLoaders();
    startObservability(
      { ...BASE, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', GIT_COMMIT: 'ABCDEF1' },
      fake.loaders,
      NO_BUILD_INFO,
    );
    expect(fake.startTracing).toHaveBeenCalledWith({
      endpoint: 'http://127.0.0.1:4318',
      release: 'abcdef1',
      environment: 'test',
    });
    expect(fake.loadSentry).not.toHaveBeenCalled();
  });

  it('starts Sentry only, with release = git commit, when the DSN is set', () => {
    const fake = fakeLoaders();
    startObservability(
      { ...BASE, SENTRY_DSN: 'https://public@sentry.example.invalid/1', GIT_COMMIT: 'abc1234' },
      fake.loaders,
      NO_BUILD_INFO,
    );
    expect(fake.initSentry).toHaveBeenCalledWith({
      dsn: 'https://public@sentry.example.invalid/1',
      release: 'abc1234',
      environment: 'test',
    });
    expect(fake.loadTracing).not.toHaveBeenCalled();
  });

  it('shutdown flushes both and is safe to repeat', async () => {
    const fake = fakeLoaders();
    startObservability(
      {
        ...BASE,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        SENTRY_DSN: 'https://public@sentry.example.invalid/1',
      },
      fake.loaders,
      NO_BUILD_INFO,
    );
    await shutdownObservability();
    await shutdownObservability();
    expect(fake.tracingShutdown).toHaveBeenCalledTimes(1);
    expect(fake.sentryClose).toHaveBeenCalledTimes(1);
  });
});
