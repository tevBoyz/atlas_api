import { loadConfigOrExit } from './bootstrap-config';

/**
 * Loads `.env` and validates the config as a side effect of being imported.
 * `main.ts` imports this FIRST: `ApiConfigModule` validates `process.env` when it is imported,
 * so `.env` must already be loaded by then. Invalid config exits here, naming keys only.
 */
export const bootConfig = loadConfigOrExit();
