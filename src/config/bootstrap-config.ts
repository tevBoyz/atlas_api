import { existsSync } from 'node:fs';

import type { LogLevel as NestLogLevel } from '@nestjs/common';

import {
  type Config,
  ConfigValidationError,
  type LogLevel,
  parseConfig,
  type TrustProxy,
} from './config.schema';

/**
 * Loads `.env` (if present; real environment variables win) and validates the config.
 * On failure prints the offending key names (never values) and exits with code 1.
 */
export function loadConfigOrExit(envFile = '.env'): Config {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  try {
    return parseConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const NEST_LEVELS: Record<Exclude<LogLevel, 'silent'>, NestLogLevel[]> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  trace: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

/** Maps LOG_LEVEL to the Nest logger setting (`false` = silent). Structured logging arrives in API-100-06. */
export function nestLogLevels(level: LogLevel): NestLogLevel[] | false {
  return level === 'silent' ? false : NEST_LEVELS[level];
}

/**
 * Converts TRUST_PROXY to Fastify's `trustProxy` option. A hop count becomes the same
 * "trust the first n hops" function Fastify builds itself (its typings omit the number form).
 */
export function fastifyTrustProxy(
  value: TrustProxy,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof value === 'number') {
    return (_address: string, hop: number) => hop < value;
  }
  return value;
}
