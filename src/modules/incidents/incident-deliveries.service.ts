import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit';
import {
  type DeliveryCounts,
  IncidentDeliveriesRepository,
} from './incident-deliveries.repository';
import { IncidentPostCommitRunner } from './incident-post-commit';
import { IncidentOperationFailedError, runIncidentTransaction } from './incident-transaction';
import { auditSessionId } from './incidents.service';

/**
 * In-app delivery counts and the member's acknowledge (spec §7.4, API-100-20):
 * `GET /v1/incidents/{id}/delivery-counts` (`incident_delivery_counts`) and
 * `POST /v1/incidents/{id}/acknowledge` (`acknowledge_incident`). Every denied read is the
 * operation's `not_found`, the same as an unknown id (hidden existence, rule 54).
 */
@Injectable()
export class IncidentDeliveriesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IncidentDeliveriesRepository,
    private readonly audit: AuditService,
    private readonly postCommit: IncidentPostCommitRunner,
  ) {}

  /**
   * `incident_delivery_counts` (final definition: baseline migration 20261117100000). One indexed
   * statement on the pool, no transaction: the app polls it every 2 s while an alert is open.
   */
  async counts(user: AuthenticatedUser, incidentId: string): Promise<DeliveryCounts> {
    // Parameters are two ids only (no medical or location values), so a database error is passed on
    // as the resident reads do.
    const body = await this.repository.visibleCounts(this.database.db, incidentId, user.id);
    if (!body) throw new DomainError('incident_delivery_counts:not_found');
    return body;
  }

  /**
   * `acknowledge_incident` (final definition: baseline migration 20261117100000), in the function's
   * order:
   * 1. lock the caller's own delivery row `FOR UPDATE` (the ONLY row lock); none → `not_found`;
   * 2. read the incident (no lock); gone, or the caller is not an active member whose membership
   *    started at or before the incident (`circle.activeMemberSince`) → `not_found`;
   * 3. status not `active` → `not_open`;
   * 4. `acknowledged_at = now()` only when `delivered_at` is set and it is not acknowledged yet.
   * A repeat writes nothing, no second audit row and no hook. Returns DeliveryCounts. A first
   * acknowledge also raises `incident.responders` (D56) after the commit.
   *
   * Lock order: one row lock and nothing after it that locks a profile. The SQL function inserts no
   * event, and `audit_log` has no foreign key (migration 0003), so the audit insert takes no lock on
   * a profile; submit, re-notify and mark safe (profile → incident → deliveries) can therefore only
   * wait on this transaction, never the reverse, and `keyShareProfile` is not needed here.
   */
  async acknowledge(user: AuthenticatedUser, incidentId: string): Promise<DeliveryCounts> {
    const operation = 'acknowledge_incident';
    const done = await runIncidentTransaction(
      this.database,
      async (tx) => {
        const delivery = await this.repository.lockOwnDelivery(tx, incidentId, user.id);
        if (!delivery) throw new DomainError('acknowledge_incident:not_found');
        const incident = await this.repository.ackIncident(tx, incidentId, user.id);
        if (!incident?.inside_window) throw new DomainError('acknowledge_incident:not_found');
        if (incident.status !== 'active') throw new DomainError('acknowledge_incident:not_open');

        const acknowledges = delivery.delivered && !delivery.acknowledged;
        if (acknowledges) await this.repository.acknowledge(tx, delivery.id);
        const body = await this.repository.counts(tx, incidentId, incident.status);
        if (acknowledges) {
          await this.audit.record(
            {
              action: 'incident.acknowledged',
              actor_user_id: user.id,
              actor_session_id: auditSessionId(user),
              target_type: 'incident',
              target_id: incident.id,
              detail: {
                delivered_count: body.delivered_count,
                acknowledged_count: body.acknowledged_count,
              },
            },
            tx,
          );
        }
        return { incident, body, acknowledged: acknowledges };
      },
      (sqlState) => new IncidentOperationFailedError(operation, sqlState),
    );
    if (done.acknowledged) {
      void this.postCommit.afterDeliveryCounts({
        incident_id: done.incident.id,
        resident_id: done.incident.resident_id,
        circle_id: done.incident.circle_id,
        delivered_count: done.body.delivered_count,
        acknowledged_count: done.body.acknowledged_count,
      });
      // SCRUM-49 / D56: the member's responder row is now "acknowledged" for everyone watching.
      void this.postCommit.afterResponders({
        incident_id: done.incident.id,
        resident_id: done.incident.resident_id,
        circle_id: done.incident.circle_id,
        member_user_id: user.id,
      });
    }
    return done.body;
  }
}
