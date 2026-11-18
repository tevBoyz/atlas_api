import { isIP } from 'node:net';

import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { currentRequestContext } from '../../common/http/request-context';
import type { Database } from '../../db';
import { auditLog } from '../../db/schema';
import { ROOT_LOGGER } from '../../observability/logger';
import type { AuditAction } from './audit.actions';
import { sanitizeAuditDetail } from './audit.detail';

/** One audit entry (API-100-14 AC2). `detail` is sanitized before it is stored (AC4). */
export interface AuditEntry {
  action: AuditAction;
  actor_user_id: string | null;
  actor_session_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  detail?: Record<string, unknown>;
}

/** The caller's open transaction: `database.db.transaction((tx) => ...)`. */
export type AuditTransaction = Pick<Database, 'insert'>;

/**
 * Writes the append-only audit log (API-100-14). The transaction is a required argument, so a row
 * commits or rolls back together with the action it records. Request id and client IP come from the
 * per-request context (AsyncLocalStorage), never from state shared between requests; outside a
 * request (a job) both are null.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async record(entry: AuditEntry, tx: AuditTransaction): Promise<void> {
    const { detail, stripped } = sanitizeAuditDetail(entry.detail);
    if (stripped.length > 0) {
      this.logger.warn({ action: entry.action, stripped }, 'audit: fields left out of detail');
    }
    const context = currentRequestContext();
    await tx.insert(auditLog).values({
      action: entry.action,
      actorUserId: entry.actor_user_id,
      actorSessionId: entry.actor_session_id ?? null,
      targetType: entry.target_type ?? null,
      targetId: entry.target_id ?? null,
      ip: context && isIP(context.ip) !== 0 ? context.ip : null,
      requestId: context?.requestId ?? null,
      detail,
    });
  }
}
