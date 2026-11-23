import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit';
import { type AvatarUrlBase, avatarUrlBase } from '../circles/circles.repository';
import { IncidentDeliveriesRepository } from './incident-deliveries.repository';
import { requireJsonObject } from './incident-input';
import { IncidentPostCommitRunner } from './incident-post-commit';
import { type ResponderView, responderView } from './incident-responder-view';
import {
  IncidentRespondersRepository,
  RESPONSE_STATUSES,
  type ResponseStatus,
} from './incident-responders.repository';
import { IncidentOperationFailedError, runIncidentTransaction } from './incident-transaction';
import { auditSessionId } from './incidents.service';

/**
 * `status` of `POST /v1/incidents/{id}/response`: the body is a JSON object (else 422
 * `validation:invalid_request` on field `body`) and `status` is exactly `responding` or `unable` (else
 * 422 `incident_response:invalid_status` on field `status`; the value is never echoed).
 */
export function responseStatusFromBody(body: unknown): ResponseStatus {
  const value = requireJsonObject(body).status;
  if (typeof value !== 'string' || !(RESPONSE_STATUSES as readonly string[]).includes(value)) {
    throw new DomainError('incident_response:invalid_status', { details: { field: 'status' } });
  }
  return value as ResponseStatus;
}

/**
 * Responder status (SCRUM-49/50/51/55, decision D56): the member's response
 * (`POST /v1/incidents/{id}/response`) and the responder list (`GET /v1/incidents/{id}/responders`).
 * Acknowledge itself stays `IncidentDeliveriesService.acknowledge` (API-100-20, unchanged apart from
 * the `incident.responders` broadcast).
 */
@Injectable()
export class IncidentRespondersService {
  private readonly avatars: AvatarUrlBase;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IncidentRespondersRepository,
    private readonly deliveries: IncidentDeliveriesRepository,
    private readonly audit: AuditService,
    private readonly postCommit: IncidentPostCommitRunner,
    config: ApiConfigService,
  ) {
    this.avatars = avatarUrlBase(config);
  }

  /**
   * The responder list in a read-only transaction in UTC. The resident (any status) or a member
   * inside the window while the incident is `active` / `resolved` (`incident.eventsView`); anything
   * else, including an unknown id, is 404 `incident_responders:not_found`. Read-only on a resolved
   * incident (the statuses stay as they were at the close).
   */
  async list(user: AuthenticatedUser, incidentId: string): Promise<ResponderView[]> {
    const found = await this.database.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        return this.repository.visibleResponders(tx, incidentId, user.id, this.avatars);
      },
      { accessMode: 'read only' },
    );
    if (!found) throw new DomainError('incident_responders:not_found');
    const viewer = found.is_resident
      ? ({ resident: true } as const)
      : ({ resident: false, viewerId: user.id } as const);
    return found.rows.map((row) => responderView(row, viewer));
  }

  /**
   * The member's response, in this order:
   * 1. lock the caller's own delivery row `FOR UPDATE` (the ONLY row lock, as acknowledge); none →
   *    `not_found`;
   * 2. read the incident (no lock); gone, or the caller does not pass `incident.memberView` (an
   *    `active` member whose membership started at or before the incident, rule 54) → `not_found`;
   * 3. status not `active` → 409 `not_open` (a resolved alert's statuses are frozen);
   * 4. the same status again → nothing is written (the time is kept), no audit, no broadcast;
   *    otherwise `response_status`, `response_at = now()` and, when empty, `acknowledged_at = now()`,
   *    plus one audit row `incident.response_set`.
   * Answers the caller's own responder row (`user_id` in full, `is_me` true).
   *
   * Lock order: one delivery row lock and nothing after it that locks another row (the incident and
   * the membership are read without a lock; the update changes no foreign-key column, so it takes no
   * key-share lock on the member row; `audit_log` has no foreign key), exactly as acknowledge. Submit,
   * re-notify, mark safe (profile → incident → deliveries) and member removal (member row →
   * deliveries) can therefore only wait on this transaction, never the reverse.
   */
  async respond(
    user: AuthenticatedUser,
    incidentId: string,
    status: ResponseStatus,
  ): Promise<ResponderView> {
    const done = await runIncidentTransaction(
      this.database,
      async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        const delivery = await this.repository.lockOwnDelivery(tx, incidentId, user.id);
        if (!delivery) throw new DomainError('incident_response:not_found');
        const incident = await this.repository.responseIncident(tx, incidentId, user.id);
        if (!incident?.member_view) throw new DomainError('incident_response:not_found');
        if (incident.status !== 'active') throw new DomainError('incident_response:not_open');

        const changed = delivery.response_status !== status;
        const acknowledgedNow = changed && !delivery.acknowledged;
        let counts: { delivered_count: number; acknowledged_count: number } | undefined;
        if (changed) {
          await this.repository.setResponse(tx, delivery.id, status);
          if (acknowledgedNow) {
            counts = await this.deliveries.counts(tx, incidentId, incident.status);
          }
          await this.audit.record(
            {
              action: 'incident.response_set',
              actor_user_id: user.id,
              actor_session_id: auditSessionId(user),
              target_type: 'incident',
              target_id: incident.id,
              detail: {
                delivery_id: delivery.id,
                status,
                previous_status: delivery.response_status,
                acknowledged_now: acknowledgedNow,
              },
            },
            tx,
          );
        }
        const row = await this.repository.ownRow(tx, incidentId, user.id, this.avatars);
        // The caller passed memberView in this transaction, so their row is there.
        if (!row) throw new DomainError('incident_response:not_found');
        return { incident, row, changed, counts };
      },
      (sqlState) => new IncidentOperationFailedError('incident_response', sqlState),
    );
    if (done.changed) {
      const ref = {
        incident_id: done.incident.id,
        resident_id: done.incident.resident_id,
        circle_id: done.incident.circle_id,
      };
      void this.postCommit.afterResponders({ ...ref, member_user_id: user.id });
      if (done.counts) void this.postCommit.afterDeliveryCounts({ ...ref, ...done.counts });
    }
    return responderView(done.row, { resident: false, viewerId: user.id });
  }
}
