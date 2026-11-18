import './global-setup';

/** Jest globalTeardown (API-100-13): stops the containers started by `global-setup.ts`. */
export default async function globalTeardown(): Promise<void> {
  const stack = globalThis.__ATLAS_TEST_STACK__;
  globalThis.__ATLAS_TEST_STACK__ = undefined;
  await Promise.all([stack?.postgres.stop(), stack?.redis.stop()]);
}
