const sdkStart = jest.fn();
const sdkShutdown = jest.fn(() => Promise.resolve());
const sdkConstructor = jest.fn<void, [unknown]>();
const exporterConstructor = jest.fn();

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn().mockImplementation((options: unknown) => {
    sdkConstructor(options);
    return { start: sdkStart, shutdown: sdkShutdown };
  }),
}));

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn().mockImplementation((options: unknown) => {
    exporterConstructor(options);
    return { fake: 'exporter' };
  }),
}));

import { safePath, startTracing, tracesUrl } from './tracing';

describe('OpenTelemetry tracing (API-100-06 AC3)', () => {
  it('builds the OTLP/HTTP traces URL from the endpoint', () => {
    expect(tracesUrl('http://collector:4318')).toBe('http://collector:4318/v1/traces');
    expect(tracesUrl('http://collector:4318/')).toBe('http://collector:4318/v1/traces');
  });

  it('strips query strings and scrubs paths in span URLs', () => {
    expect(safePath('/v1/invites/abcdefghijkl?phone=%2B12015550101')).toBe(
      '/v1/invites/[REDACTED]',
    );
  });

  it('starts the Node SDK with the OTLP exporter and the HTTP, Fastify, pg and ioredis instrumentations', async () => {
    const handle = startTracing({
      endpoint: 'http://127.0.0.1:4318',
      release: 'abc1234',
      environment: 'test',
    });
    expect(exporterConstructor).toHaveBeenCalledWith({ url: 'http://127.0.0.1:4318/v1/traces' });
    expect(sdkStart).toHaveBeenCalledTimes(1);

    const options = sdkConstructor.mock.calls[0]?.[0] as {
      instrumentations: { instrumentationName: string }[];
      traceExporter: unknown;
    };
    expect(options.traceExporter).toEqual({ fake: 'exporter' });
    const names = options.instrumentations.map((i) => i.instrumentationName);
    expect(names).toEqual(
      expect.arrayContaining([
        '@opentelemetry/instrumentation-http',
        '@fastify/otel',
        '@opentelemetry/instrumentation-pg',
        '@opentelemetry/instrumentation-ioredis',
      ]),
    );
    for (const instrumentation of options.instrumentations) {
      (instrumentation as unknown as { disable(): void }).disable();
    }

    await handle.shutdown();
    expect(sdkShutdown).toHaveBeenCalledTimes(1);
  });
});
