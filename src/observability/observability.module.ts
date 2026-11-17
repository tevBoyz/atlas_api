import type { IncomingMessage } from 'node:http';

import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream, Logger } from 'pino';

import { ApiConfigService } from '../config';
import { shutdownObservability } from './instrument';
import {
  createRootLogger,
  LOG_DESTINATION,
  passThroughSerializer,
  REQUEST_ID_LOG_KEY,
  ROOT_LOGGER,
  stdoutDestination,
} from './logger';
import { resolveRequestId } from './request-id';

/** Provides the root logger and its destination app-wide. */
@Global()
@Module({
  providers: [
    { provide: LOG_DESTINATION, useFactory: stdoutDestination },
    {
      provide: ROOT_LOGGER,
      inject: [ApiConfigService, LOG_DESTINATION],
      useFactory: (config: ApiConfigService, destination: DestinationStream): Logger =>
        createRootLogger(config.get('LOG_LEVEL'), destination),
    },
  ],
  exports: [LOG_DESTINATION, ROOT_LOGGER],
})
export class RootLoggerModule {}

/** Flushes traces and Sentry events when the app shuts down. */
@Injectable()
class ObservabilityShutdown implements OnApplicationShutdown {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async onApplicationShutdown(): Promise<void> {
    await shutdownObservability();
    this.logger.flush();
  }
}

/**
 * Structured logging (story API-100-06): nestjs-pino on top of the root logger. Nest's own logs and
 * `PinoLogger` / `Logger` in services go to the same JSON stream; inside a request they carry
 * `request_id`. Automatic request/response logging (which would include headers) is off: the
 * completion line comes from `installHttpHooks` instead.
 */
@Global()
@Module({
  imports: [
    RootLoggerModule,
    LoggerModule.forRootAsync({
      imports: [RootLoggerModule],
      inject: [ROOT_LOGGER],
      useFactory: (logger: Logger) => ({
        pinoHttp: {
          logger,
          autoLogging: false,
          quietReqLogger: true,
          customAttributeKeys: { reqId: REQUEST_ID_LOG_KEY },
          // Keep the root logger's serializers (errors arrive already scrubbed).
          wrapSerializers: false,
          serializers: { err: passThroughSerializer },
          // Fastify's genReqId already stored the id on the raw request; this is only a fallback.
          genReqId: (req: IncomingMessage) => resolveRequestId(req.headers['x-request-id']),
        },
      }),
    }),
  ],
  providers: [ObservabilityShutdown],
  exports: [RootLoggerModule, LoggerModule],
})
export class ObservabilityModule {}
