import { Module } from '@nestjs/common';

import { AuditService } from './audit.service';

/**
 * The append-only audit log (API-100-14). Feature modules import this module and call
 * {@link AuditService.record} inside their own transaction. There is no read endpoint in Epic 100.
 */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
