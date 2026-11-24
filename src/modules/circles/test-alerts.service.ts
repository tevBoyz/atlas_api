import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { OutboxWriter } from '../../jobs/outbox';
import { OutboxRelay } from '../../jobs/outbox-relay.service';
import { ROOT_LOGGER } from '../../observability/logger';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { SERVER_EVENTS, userRoom } from '../../realtime/realtime.constants';
import { AuditService } from '../audit';
import { auditSessionId } from '../incidents/incidents.service';
import { readTestAlertRateSettings } from './test-alert-settings';
import {
  recipientState,
  type TestAlertFailureReason,
  type TestAlertMemberState,
} from './test-alert-status';
import {
  type MemberTestAlertRow,
  type OwnerTestAlertRow,
  type SentTestAlert,
  type TestAlertTransaction,
  TestAlertsRepository,
} from './test-alerts.repository';

/** One recipient in the owner's status (D68). */
export interface TestAlertRecipientJson {
  user_id: string;
  display_name: string | null;
  status: TestAlertMemberState;
  failure_reason: TestAlertFailureReason | null;
  delivered_at: string | null;
  seen_at: string | null;
}

/** The owner's status of one test alert (D68). The four counts add up to `recipient_count`. */
export interface TestAlertStatusJson {
  id: string;
  circle_id: string;
  created_at: string;
  recipient_count: number;
  delivered_count: number;
  seen_count: number;
  failed_count: number;
  pending_count: number;
  recipients: TestAlertRecipientJson[];
}

/** A recipient's view of a test alert (D68). */
export interface MemberTestAlertJson {
  id: string;
  owner_name: string | null;
  created_at: string;
  is_test: true;
  seen_at: string | null;
}

/**
 * SCRUM-35 test alerts (D66-D68). The owner sends a test to the ACTIVE members of their circle and
 * reads its delivery status; a recipient reads it and marks it seen. A test is stored in its own
 * tables (migration 0018): this service never reads or writes an incident, incident event,
 * responder row, live location, the emergency numbers or the SOS rate limit.
 */
@Injectable()
export class TestAlertsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: TestAlertsRepository,
    private readonly outbox: OutboxWriter,
    private readonly relay: OutboxRelay,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * D66, in one transaction (UTC):
   * 1. lock the caller's circle row (`FOR UPDATE`: two sends of one owner run one after the other);
   *    no circle → 409 `no_eligible_recipients`;
   * 2. recipients = the ACTIVE members (owner excluded); none → 409 `no_eligible_recipients`
   *    (nothing stored or sent);
   * 3. rate limit (1 per `circle_test_alert_min_interval_minutes`, `circle_test_alert_daily_max` per
   *    24 hours) → 429 `rate_limited` with `Retry-After` and `details {retry_after_seconds,
   *    next_allowed_at, reason}`;
   * 4. the test row, one receipt per recipient, one `circle.test_alert` outbox row, one audit row.
   * After the commit: the relay is kicked (push) and `circle.test_alert` goes to each recipient's
   * user room.
   */
  async send(user: AuthenticatedUser): Promise<SentTestAlert> {
    const done = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
      const circle = await this.repository.lockOwnerCircle(tx, user.id);
      if (!circle) throw new DomainError('test_alerts:no_eligible_recipients');
      const recipients = await this.repository.activeRecipients(tx, circle.circle_id);
      if (recipients.length === 0) throw new DomainError('test_alerts:no_eligible_recipients');

      const settings = await readTestAlertRateSettings(tx);
      const verdict = await this.repository.rateVerdict(tx, user.id, settings);
      if (verdict.limited) {
        throw new DomainError('test_alerts:rate_limited', {
          retryAfterSeconds: verdict.retry_after_seconds,
          details: {
            retry_after_seconds: verdict.retry_after_seconds,
            next_allowed_at: verdict.next_allowed_at,
            reason: verdict.reason,
          },
        });
      }

      const sent = await this.repository.insert(tx, {
        circleId: circle.circle_id,
        ownerId: user.id,
        recipients,
      });
      await this.outbox.insert(tx, {
        topic: 'circle.test_alert',
        aggregateId: sent.id,
        payload: sql`${JSON.stringify({
          test_alert_id: sent.id,
          circle_id: circle.circle_id,
          owner_name: circle.owner_name,
          occurred_at: sent.created_at,
          recipient_user_ids: recipients,
        })}::jsonb`,
      });
      await this.audit.record(
        {
          action: 'circle.test_alert.sent',
          actor_user_id: user.id,
          actor_session_id: auditSessionId(user),
          target_type: 'circle_test_alert',
          target_id: sent.id,
          detail: { circle_id: circle.circle_id, recipient_count: sent.recipient_count },
        },
        tx,
      );
      return { sent, recipients, ownerName: circle.owner_name };
    });

    this.relay.kick();
    try {
      this.realtime.emit(done.recipients.map(userRoom), SERVER_EVENTS.testAlert, {
        test_alert_id: done.sent.id,
        owner_name: done.ownerName,
        created_at: done.sent.created_at,
        occurred_at: done.sent.created_at,
      });
    } catch (err) {
      this.logger.warn({ err, test_alert_id: done.sent.id }, 'test alert broadcast failed');
    }
    return done.sent;
  }

  /** D68: the owner's status of one of their tests; anything else → 404 `not_found`. */
  async status(user: AuthenticatedUser, testAlertId: string): Promise<TestAlertStatusJson> {
    const found = await this.readOnly((tx) => this.repository.ownerView(tx, user.id, testAlertId));
    if (!found) throw new DomainError('test_alerts:not_found');
    return statusJson(found);
  }

  /** D68: the owner's latest test (`{test_alert: null}` when they never sent one). */
  async latest(user: AuthenticatedUser): Promise<{ test_alert: TestAlertStatusJson | null }> {
    const found = await this.readOnly(async (tx) => {
      const id = await this.repository.latestId(tx, user.id);
      return id ? this.repository.ownerView(tx, user.id, id) : undefined;
    });
    return { test_alert: found ? statusJson(found) : null };
  }

  /** D68: a recipient (still an active member) reads the test; anyone else → 404 `not_found`. */
  async memberRead(user: AuthenticatedUser, testAlertId: string): Promise<MemberTestAlertJson> {
    const found = await this.readOnly((tx) => this.repository.memberView(tx, user.id, testAlertId));
    if (!found) throw new DomainError('test_alerts:not_found');
    return memberJson(found);
  }

  /** D68: the recipient opened the test. Idempotent: a repeat keeps the first `seen_at`. */
  async markSeen(user: AuthenticatedUser, testAlertId: string): Promise<MemberTestAlertJson> {
    const found = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
      await this.repository.markSeen(tx, user.id, testAlertId);
      return this.repository.memberView(tx, user.id, testAlertId);
    });
    if (!found) throw new DomainError('test_alerts:not_found');
    return memberJson(found);
  }

  private readOnly<T>(work: (tx: TestAlertTransaction) => Promise<T>): Promise<T> {
    return this.database.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        return work(tx);
      },
      { accessMode: 'read only' },
    );
  }
}

function memberJson(row: MemberTestAlertRow): MemberTestAlertJson {
  return {
    id: row.id,
    owner_name: row.owner_name,
    created_at: row.created_at,
    is_test: true,
    seen_at: row.seen_at,
  };
}

function statusJson(row: OwnerTestAlertRow): TestAlertStatusJson {
  const recipients: TestAlertRecipientJson[] = row.recipients.map((r) => {
    const state = recipientState(r);
    return {
      user_id: r.user_id,
      display_name: r.display_name,
      status: state.status,
      failure_reason: state.failure_reason,
      delivered_at: r.delivered_at,
      seen_at: r.seen_at,
    };
  });
  const count = (status: TestAlertMemberState) =>
    recipients.filter((r) => r.status === status).length;
  return {
    id: row.id,
    circle_id: row.circle_id,
    created_at: row.created_at,
    recipient_count: row.recipient_count,
    delivered_count: count('delivered'),
    seen_count: count('seen'),
    failed_count: count('failed'),
    pending_count: count('pending'),
    recipients,
  };
}
