import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENCY_METADATA = 'atlas:idempotency';

/**
 * - `required`: a request without `Idempotency-Key` → 400 `idempotency:key_required`
 *   (`POST /v1/incidents`, `POST /v1/incidents/{id}/mark-safe`, spec §11.3 E1/E6).
 * - `optional`: honoured when sent, otherwise the request runs normally (invite creation, I1-I3).
 */
export type IdempotencyMode = 'required' | 'optional';

/**
 * Opts a route into Idempotency-Key handling (API-100-10 AC2). The route must be authenticated
 * (keys are stored per user; the route contract check fails the boot otherwise).
 */
export const Idempotent = (mode: IdempotencyMode): MethodDecorator =>
  SetMetadata(IDEMPOTENCY_METADATA, mode);
