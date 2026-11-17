import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { ApiExceptionFilter } from './api-exception.filter';
import { OperationContextInterceptor } from './operation';

/** Registers the global error envelope filter and the `@Operation` context (story API-100-05). */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: OperationContextInterceptor },
  ],
})
export class ErrorsModule {}
