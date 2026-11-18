import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { type AuditAction, AuditService, type AuditTransaction } from '../audit';
import { IncidentPostCommitRunner, type IncidentSubmittedEvent } from './incident-post-commit';
import type { SubmitOutcome, SubmittableEmergencyType } from './incident.schemas';
import { type IncidentTransaction, IncidentsRepository } from './incidents.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SubmitTransaction = IncidentTransaction & AuditTransaction;

export interface SubmitResponse {
  status: 200 | 201;
  body: Record<string, unknown>;
}

interface CommittedSubmit {
  response: SubmitResponse;
  event: IncidentSubmittedEvent;
}

/**
 * A submit that failed in the database. It replaces the original error because that one can carry the
 * query parameters (the emergency type) and row values (share fields), and errors are logged and
 * reported. Only the SQLSTATE is kept.
 */
export class IncidentSubmitFailedError extends Error {
  constructor(readonly sqlState: string | undefined) {
    super('submit_emergency_alert failed in the database');
    this.name = 'IncidentSubmitFailedError';
  }
}

function sqlStateOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
}

/**
 * `POST /v1/incidents`, the API form of `submit_emergency_alert` (spec §6.4). One transaction with the
 * function's row locks in the function's order: the profile row, then the open incident. Audit is
 * written inside the transaction; post-commit hooks run only once it has committed.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IncidentsRepository,
    private readonly audit: AuditService,
    private readonly postCommit: IncidentPostCommitRunner,
  ) {}

  async submit(
    user: AuthenticatedUser,
    emergencyType: SubmittableEmergencyType,
  ): Promise<SubmitResponse> {
    let committed: CommittedSubmit;
    try {
      committed = await this.database.db.transaction((tx) =>
        this.submitInTransaction(tx, user, emergencyType),
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new IncidentSubmitFailedError(sqlStateOf(error));
    }
    // Not awaited: the alert is committed, so a slow or failing hook must not affect the response.
    void this.postCommit.afterSubmit(committed.event);
    return committed.response;
  }

  private async submitInTransaction(
    tx: SubmitTransaction,
    user: AuthenticatedUser,
    emergencyType: SubmittableEmergencyType,
  ): Promise<CommittedSubmit> {
    const residentId = user.id;
    await this.repository.useUtcTimestamps(tx);

    const profile = await this.repository.lockProfile(tx, residentId);
    if (!profile) throw new DomainError('submit_emergency_alert:profile_not_found');
    if (!profile.setup_complete) {
      throw new DomainError('submit_emergency_alert:profile_setup_incomplete');
    }

    const open = await this.repository.lockOpenIncident(tx, residentId);
    if (open?.status === 'active') return this.renotify(tx, user, open.id);

    let outcome: SubmitOutcome;
    let incident;
    if (open) {
      incident = await this.repository.promoteIncident(tx, open.id, emergencyType);
      outcome = 'promoted';
    } else {
      incident = await this.repository.insertActiveIncident(tx, residentId, emergencyType);
      if (!incident) {
        // Lost a race the profile lock should have prevented: never insert a second incident.
        const raced = await this.repository.lockActiveIncident(tx, residentId);
        if (!raced) throw new Error('_incident_apply_renotify:not_open');
        return this.renotify(tx, user, raced.id);
      }
      outcome = 'created';
    }

    if (incident.circle_id !== null) {
      await this.repository.insertDeliveries(tx, incident.id, incident.circle_id, residentId);
    }
    await this.repository.recordAlertSent(tx, incident.id, residentId);
    await this.repository.recordLocationSharingStarted(tx, incident.id, residentId);

    const body = await this.repository.submitResult(tx, incident.id, outcome);
    return this.finish(tx, user, {
      action: 'incident.created',
      status: 201,
      body,
      outcome,
      incidentId: incident.id,
      recipientCount: body.delivered_count as number,
    });
  }

  private async renotify(
    tx: SubmitTransaction,
    user: AuthenticatedUser,
    incidentId: string,
  ): Promise<CommittedSubmit> {
    const refreshed = await this.repository.applyRenotify(tx, incidentId, user.id);
    if (refreshed === undefined) throw new Error('_incident_apply_renotify:not_open');
    const body = await this.repository.submitResult(tx, incidentId, 'renotified');
    return this.finish(tx, user, {
      action: 'incident.renotified',
      status: 200,
      body,
      outcome: 'renotified',
      incidentId,
      recipientCount: refreshed,
    });
  }

  /** Audit `detail` holds the count and outcome only: never the emergency type or a share field. */
  private async finish(
    tx: AuditTransaction,
    user: AuthenticatedUser,
    result: {
      action: AuditAction;
      status: 200 | 201;
      body: Record<string, unknown>;
      outcome: SubmitOutcome;
      incidentId: string;
      recipientCount: number;
    },
  ): Promise<CommittedSubmit> {
    const { action, status, body, outcome, incidentId, recipientCount } = result;
    await this.audit.record(
      {
        action,
        actor_user_id: user.id,
        // The column is a uuid and the claim is not validated: a bad claim must not fail an SOS.
        actor_session_id: user.sessionId && UUID.test(user.sessionId) ? user.sessionId : null,
        target_type: 'incident',
        target_id: incidentId,
        detail: { recipient_count: recipientCount, submit_outcome: outcome },
      },
      tx,
    );
    return {
      response: { status, body },
      event: {
        incident_id: incidentId,
        resident_id: user.id,
        circle_id: body.circle_id as string | null,
        submit_outcome: outcome,
        recipient_count: recipientCount,
      },
    };
  }
}
