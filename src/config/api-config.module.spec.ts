import { inspect } from 'node:util';

import { Test } from '@nestjs/testing';

import type { ApiConfigModule as ApiConfigModuleType } from './api-config.module';
import type { ApiConfigService as ApiConfigServiceType } from './api-config.service';
import { fastifyTrustProxy } from './bootstrap-config';

type Loaded = {
  ApiConfigModule: typeof ApiConfigModuleType;
  ApiConfigService: typeof ApiConfigServiceType;
};

/** ApiConfigModule validates process.env when imported, so load a fresh copy per test. */
function loadFresh(): Loaded {
  let loaded: Loaded | undefined;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { ApiConfigModule } = require('./api-config.module') as Pick<Loaded, 'ApiConfigModule'>;
    const { ApiConfigService } = require('./api-config.service') as Pick<
      Loaded,
      'ApiConfigService'
    >;
    /* eslint-enable @typescript-eslint/no-require-imports */
    loaded = { ApiConfigModule, ApiConfigService };
  });
  if (!loaded) throw new Error('module did not load');
  return loaded;
}

async function compileWithEnv(env: Record<string, string>) {
  Object.assign(process.env, env);
  const { ApiConfigModule, ApiConfigService } = loadFresh();
  const moduleRef = await Test.createTestingModule({ imports: [ApiConfigModule] }).compile();
  return { moduleRef, config: moduleRef.get(ApiConfigService) };
}

const KEYS = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'CHANNEL_PUSH_ENABLED',
  'SUPABASE_STORAGE_SERVICE_KEY',
];

describe('ApiConfigModule (API-100-02)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('serves typed, validated values from process.env', async () => {
    const { moduleRef, config } = await compileWithEnv({
      NODE_ENV: 'test',
      PORT: '4321',
      CHANNEL_PUSH_ENABLED: 'true',
      LOG_LEVEL: '',
    });

    expect(config.get('PORT')).toBe(4321);
    expect(config.get('CHANNEL_PUSH_ENABLED')).toBe(true);
    expect(config.get('LOG_LEVEL')).toBe('info');
    expect(config.get('AVATARS_BUCKET')).toBe('avatars');
    expect(config.get('SENTRY_DSN')).toBeUndefined();
    expect(config.isProduction).toBe(false);
    await moduleRef.close();
  });

  it('never serializes or inspects to its values', async () => {
    const { moduleRef, config } = await compileWithEnv({
      NODE_ENV: 'test',
      SUPABASE_STORAGE_SERVICE_KEY: 'fake-secret-for-tests-0123456789-LEAK',
    });

    expect(config.get('SUPABASE_STORAGE_SERVICE_KEY')).toContain('LEAK');
    expect(JSON.stringify({ config })).not.toContain('LEAK');
    expect(inspect(config)).not.toContain('LEAK');
    await moduleRef.close();
  });

  it('refuses to start with an invalid value, naming the key only', async () => {
    await expect(compileWithEnv({ NODE_ENV: 'test', PORT: 'not-a-port' })).rejects.toThrow(
      /Invalid configuration:\n {2}- PORT: must be an integer/,
    );
  });
});

describe('bootstrap helpers', () => {
  it('passes boolean and address-list TRUST_PROXY through unchanged', () => {
    expect(fastifyTrustProxy(false)).toBe(false);
    expect(fastifyTrustProxy(['10.0.0.0/8'])).toEqual(['10.0.0.0/8']);
  });

  it('turns a TRUST_PROXY hop count into a "first n hops" function', () => {
    const trust = fastifyTrustProxy(2);
    expect(typeof trust).toBe('function');
    if (typeof trust !== 'function') return;
    expect(trust('10.0.0.1', 0)).toBe(true);
    expect(trust('10.0.0.1', 1)).toBe(true);
    expect(trust('10.0.0.1', 2)).toBe(false);
  });
});
