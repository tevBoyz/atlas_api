import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { LogLevel } from '../config';
import { scrub } from './scrubber';

/** DI token: the root pino logger every log line goes through. */
export const ROOT_LOGGER = Symbol('ROOT_LOGGER');
/** DI token: where log lines are written (stdout; tests override it to capture lines). */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

/** Name of the request-id field in every log line of a request (same name as `audit_log.request_id`). */
export const REQUEST_ID_LOG_KEY = 'request_id';

/** Scrubs every argument of a log call: objects, errors and message strings (story API-100-06 AC2). */
export function scrubLogArguments(args: unknown[]): unknown[] {
  return args.map((arg, index) =>
    // pino logs a leading Error under `err`; keep that shape after scrubbing it into a plain object.
    index === 0 && arg instanceof Error ? { err: scrub(arg) } : scrub(arg),
  );
}

/**
 * `err` is already a scrubbed plain object (see {@link scrubLogArguments}): keep it as is. pino's
 * default error serializer would re-derive `type` from the plain object ("Object").
 */
export const passThroughSerializer = (value: unknown): unknown => value;

/** pino options for the API (exported for tests). */
export function rootLoggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    base: { service: 'atlas-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: passThroughSerializer },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, scrubLogArguments(args) as Parameters<typeof method>);
      },
    },
  };
}

/** The root JSON logger (story API-100-06 AC1). Level from LOG_LEVEL (`silent` turns logging off). */
export function createRootLogger(level: LogLevel, destination: DestinationStream): Logger {
  return pino(rootLoggerOptions(level), destination);
}

/** Default destination: stdout, synchronous (no lines lost on a crash). */
export function stdoutDestination(): DestinationStream {
  return pino.destination({ dest: 1, sync: true });
}
