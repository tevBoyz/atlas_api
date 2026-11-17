import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { IdempotencyHookInstaller, IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyStore } from './idempotency.store';

/**
 * Idempotency-Key support (API-100-10): the global {@link IdempotencyInterceptor} (acts only on
 * `@Idempotent()` routes) and its store. `configureApp` installs the onSend hook that records
 * responses ({@link IdempotencyHookInstaller}).
 */
@Module({
  providers: [
    IdempotencyStore,
    IdempotencyHookInstaller,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyStore, IdempotencyHookInstaller],
})
export class IdempotencyModule {}
