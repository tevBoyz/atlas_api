/** Version of the API contract: `package.json`, `openapi.json` and the Dart client all carry it. */
export const API_VERSION = '0.1.0';

/** Global prefix for every REST route (spec §11.2). */
export const API_PREFIX = 'v1';

/** Routes served without the `/v1` prefix: health and readiness (spec §11.3 H1/H2, story API-100-07). */
export const UNPREFIXED_ROUTES = ['healthz', 'readyz'];
