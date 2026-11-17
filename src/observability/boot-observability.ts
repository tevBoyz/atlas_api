import { bootConfig } from '../config/boot-config';
import { startObservability } from './instrument';

/**
 * Starts OpenTelemetry and Sentry as a side effect of being imported. `main.ts` imports this right
 * after `config/boot-config` and BEFORE Nest, Fastify, pg or ioredis, so the instrumentations can
 * patch those modules when they load. Does nothing when OTEL_EXPORTER_OTLP_ENDPOINT and SENTRY_DSN
 * are unset.
 */
export const bootObservability = startObservability(bootConfig);
