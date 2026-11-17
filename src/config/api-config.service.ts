import { inspect } from 'node:util';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Config, ConfigKey } from './config.schema';

/**
 * Typed, read-only access to the validated environment configuration.
 * Inject this instead of reading `process.env`. It never serializes or prints its values.
 */
@Injectable()
export class ApiConfigService {
  constructor(private readonly config: ConfigService<Config, true>) {}

  get<K extends ConfigKey>(key: K): Config[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  /** Guards against accidentally logging or returning the config. */
  toJSON(): string {
    return '[ApiConfigService]';
  }

  [inspect.custom](): string {
    return '[ApiConfigService]';
  }
}
