import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { type AuditAction, AuditService, type AuditTransaction } from '../audit';
import { IncidentNotificationsOutbox } from '../notifications/incident-notifications';
import { IncidentEventService, type RecordedIncidentEvent } from './incident-events.service';
import { IncidentPostCommitRunner, type IncidentSubmittedEvent } from './incident-post-commit';
import { IncidentStateService } from './incident-state.service';
import {
  IncidentOperationFailedError,
  IncidentSubmitFailedError,
  type IncidentWriteTransaction,
  runIncidentTransaction,
} from './incident-transaction';
import type { SubmitOutcome, SubmittableEmergencyType } from './incident.schemas';
import { IncidentsRepository, type LockedIncidentRow } from './incidents.repository';

// Kept importable from here (API-100-15 callers and tests).
export { IncidentOperationFailedError, IncidentSubmitFailedError } from './incident-transaction';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubmitResponse {
  status: 200 | 201;
  body: Record<string, unknown>;
}

interface CommittedSubmit {
  response: SubmitResponse;
  event: IncidentSubmittedEvent;
  /** The `incident_events` rows the submit inserted (API-100-22 hook `incident.event`). */
  events?: RecordedIncidentEvent[];
}

/** The audit row's session id: the claim only when it is a uuid (a bad claim must not fail a write). */
export function auditSessionId(user: AuthenticatedUser): string | null {
  return user.sessionId && UUID.test(user.sessionId) ? user.sessionId : null;
}

/**
 * The resident's incident writes (spec §6.4, §6.6, §7.4): `POST /v1/incidents`
 * (`submit_emergency_alert`), `PUT /v1/incidents/{id}/notes` (`set_incident_notes`),
 * `POST /v1/incidents/{id}/renotify` (`renotify_emergency_alert`) and
 * `POST /v1/incidents/{id}/mark-safe` (`mark_incident_safe`). Each is one transaction with the SQL
 * function's row locks in the function's order. Audit and the notification outbox row (API-100-48)
 * are written inside the transaction; post-commit hooks run only once it has committed, and the
 * response never waits for them (notifications are sent by the worker, never by the request).
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IncidentsRepository,
    private readonly audit: AuditService,
    private readonly postCommit: IncidentPostCommitRunner,
    private readonly events: IncidentEventService,
    private readonly notifications: IncidentNotificationsOutbox,
    private readonly state: IncidentStateService,
  ) {}

  async submit(
    user: AuthenticatedUser,
    emergencyType: SubmittableEmergencyType,
  ): Promise<SubmitResponse> {
    const committed = await runIncidentTransaction(
      this.database,
      async (tx) => ({
        ...(await this.submitInTransaction(tx, user, emergencyType)),
        events: this.events.drain(tx),
      }),
      (sqlState) => new IncidentSubmitFailedError(sqlState),
    );
    // Not awaited: the alert is committed, so a slow or failing hook must not affect the response.
    void this.postCommit.afterSubmit(committed.event);
    this.afterEvents(committed.event, committed.events);
    return committed.response;
  }

  /**
   * `set_incident_notes` (final definition: baseline migration 20261020150000): the caller's own
   * incident (`not_found`), in `activating`/`active` (`not_open`), note trimmed with `btrim`, empty →
   * null, more than 250 characters → `too_long`; `incident_notes_updated_at = now()` on every write,
   * also when clearing. Never touches `share_payload`. Returns IncidentShared.
   *
   * `incidentId` is valid uuid input and `notes` is text Postgres can hold (checked by the caller).
   */
  async setNotes(
    user: AuthenticatedUser,
    incidentId: string,
    notes: string | null,
  ): Promise<Record<string, unknown>> {
    const operation = 'set_incident_notes';
    const written = await runIncidentTransaction(
      this.database,
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        const incident = await this.repository.lockOwnIncident(tx, incidentId, user.id);
        if (!incident) throw new DomainError('set_incident_notes:not_found');
        if (incident.status !== 'activating' && incident.status !== 'active') {
          throw new DomainError('set_incident_notes:not_open');
        }
        const result = await this.repository.setNotes(tx, incident.id, notes);
        if (!result) throw new DomainError('set_incident_notes:too_long');
        // `detail` never holds the note itself (API-100-14 AC4).
        await this.recordAudit(tx, user, 'incident.notes_set', incident.id, {
          cleared: result.cleared,
        });
        return { incident, ...result };
      },
      (sqlState) => new IncidentOperationFailedError(operation, sqlState),
    );
    void this.postCommit.afterNotes({
      incident_id: written.incident.id,
      resident_id: user.id,
      circle_id: written.body.circle_id as string | null,
      cleared: written.cleared,
    });
    return written.body;
  }

  /**
   * `renotify_emergency_alert` (final definition: baseline migration 20261023150000): lock the
   * caller's own incident (`not_found`), status must be `active` (`not_open`), then the same re-notify
   * a submit on an active incident runs (`_incident_apply_renotify`). Returns IncidentSend.
   */
  async renotify(user: AuthenticatedUser, incidentId: string): Promise<Record<string, unknown>> {
    const operation = 'renotify_emergency_alert';
    const done = await runIncidentTransaction(
      this.database,
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        // Same lock order as submit (profile before incident): see keyShareProfile.
        await this.repository.keyShareProfile(tx, user.id);
        const incident: LockedIncidentRow | undefined = await this.repository.lockOwnIncident(
          tx,
          incidentId,
          user.id,
        );
        if (!incident) throw new DomainError('renotify_emergency_alert:not_found');
        if (incident.status !== 'active') {
          throw new DomainError('renotify_emergency_alert:not_open');
        }
        const recipientCount = await this.applyRenotify(tx, user, incident.id);
        await this.notifications.renotified(tx, incident.id);
        const body = await this.withEmergencyServices(
          tx,
          await this.repository.liveResult(tx, incident.id),
        );
        await this.recordAudit(tx, user, 'incident.renotified', incident.id, {
          recipient_count: recipientCount,
        });
        return { incidentId: incident.id, body, recipientCount, events: this.events.drain(tx) };
      },
      (sqlState) => new IncidentOperationFailedError(operation, sqlState),
    );
    const ref = {
      incident_id: done.incidentId,
      resident_id: user.id,
      circle_id: done.body.circle_id as string | null,
    };
    void this.postCommit.afterRenotify({ ...ref, recipient_count: done.recipientCount });
    this.afterEvents(ref, done.events);
    return done.body;
  }

  /**
   * `mark_incident_safe` (final definition: baseline migration 20261023140000; its recipient helper
   * `_incident_active_recipient_ids`: 20261117100000). In the function's order: lock the caller's own
   * incident (`not_found`); already `resolved`/`safe` → the unchanged IncidentSend and nothing written
   * (no events, no timestamps, no audit, no hook); any other status than `active` → `not_open` (also
   * `closed`, SCRUM-63: a closed alert is final); else `active -> resolved` through the state service
   * (D61), read the closure recipients (rule 54) and log the closure events once each:
   * `safe_recorded`, `location_sharing_ended`, `closure_notified`. Since SCRUM-63 (D62) mark safe no
   * longer writes `incident_closed`: the close sweeper writes it when the incident really closes (a
   * recorded divergence from the SQL function, which still writes it). Returns IncidentSend.
   */
  async markSafe(user: AuthenticatedUser, incidentId: string): Promise<Record<string, unknown>> {
    const operation = 'mark_incident_safe';
    const done = await runIncidentTransaction(
      this.database,
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        // Same lock order as submit (profile before incident): see keyShareProfile.
        await this.repository.keyShareProfile(tx, user.id);
        const incident = await this.repository.lockOwnIncident(tx, incidentId, user.id);
        if (!incident) throw new DomainError('mark_incident_safe:not_found');
        if (incident.status === 'resolved' && incident.resolved_reason === 'safe') {
          return {
            closed: undefined,
            body: await this.repository.sendResult(tx, incident.id),
            events: [],
          };
        }
        if (incident.status !== 'active') throw new DomainError('mark_incident_safe:not_open');

        const closed = await this.state.resolveSafe(tx, incident.id, incident.status);
        if (!closed) throw new Error('mark_incident_safe:not_open');
        const recipientIds = await this.repository.closureRecipientIds(tx, incident.id);
        await this.repository.recordClosureEvents(tx, incident.id, user.id, recipientIds);
        // The closure notice goes to closure_notified.recipient_ids (API-100-48 AC2).
        await this.notifications.resolved(tx, incident.id, recipientIds);
        const body = await this.repository.sendResult(tx, incident.id);
        // Counts only: never the emergency type, share payload, location or notes.
        await this.recordAudit(tx, user, 'incident.resolved', incident.id, {
          recipient_count: recipientIds.length,
        });
        return {
          closed: {
            incident_id: incident.id,
            resident_id: user.id,
            circle_id: closed.circle_id,
            recipient_count: recipientIds.length,
          },
          body,
          events: this.events.drain(tx),
        };
      },
      (sqlState) => new IncidentOperationFailedError(operation, sqlState),
    );
    // Only the call that closed the incident, and only once that has committed.
    if (done.closed) {
      void this.postCommit.afterResolved(done.closed);
      this.afterEvents(done.closed, done.events);
    }
    return done.body;
  }

  private async submitInTransaction(
    tx: IncidentWriteTransaction,
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
    if (open?.status === 'active') return this.submitRenotify(tx, user, open.id);

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
        return this.submitRenotify(tx, user, raced.id);
      }
      outcome = 'created';
    }

    if (incident.circle_id !== null) {
      await this.repository.insertDeliveries(tx, incident.id, incident.circle_id, residentId);
    }
    await this.repository.recordAlertSent(tx, incident.id, residentId);
    await this.repository.recordLocationSharingStarted(tx, incident.id, residentId);
    await this.notifications.created(tx, incident.id);

    const body = await this.withEmergencyServices(
      tx,
      await this.repository.submitResult(tx, incident.id, outcome),
    );
    return this.finishSubmit(tx, user, {
      action: 'incident.created',
      status: 201,
      body,
      outcome,
      incidentId: incident.id,
      recipientCount: body.delivered_count as number,
    });
  }

  /**
   * `_incident_apply_renotify` (spec rule 29), the one re-notify of submit and of explicit re-notify.
   * The caller holds the incident row lock. Returns the number of delivery rows refreshed.
   */
  private async applyRenotify(
    tx: IncidentWriteTransaction,
    user: AuthenticatedUser,
    incidentId: string,
  ): Promise<number> {
    const refreshed = await this.repository.applyRenotify(tx, incidentId, user.id);
    if (refreshed === undefined) throw new Error('_incident_apply_renotify:not_open');
    return refreshed;
  }

  private async submitRenotify(
    tx: IncidentWriteTransaction,
    user: AuthenticatedUser,
    incidentId: string,
  ): Promise<CommittedSubmit> {
    const refreshed = await this.applyRenotify(tx, user, incidentId);
    await this.notifications.renotified(tx, incidentId);
    const body = await this.withEmergencyServices(
      tx,
      await this.repository.submitResult(tx, incidentId, 'renotified'),
    );
    return this.finishSubmit(tx, user, {
      action: 'incident.renotified',
      status: 200,
      body,
      outcome: 'renotified',
      incidentId,
      recipientCount: refreshed,
    });
  }

  /** Audit `detail` holds the count and outcome only: never the emergency type or a share field. */
  private async finishSubmit(
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
    await this.recordAudit(tx, user, action, incidentId, {
      recipient_count: recipientCount,
      submit_outcome: outcome,
    });
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

  /**
   * SCRUM-54 (D60): the body plus `emergency_services` (the local emergency numbers, fixed order
   * ambulance, police, fire_rescue) for the resident's live alert screen: submit (every outcome) and
   * re-notify. Mark safe (the alert is over), notes and location keep the SQL shapes.
   */
  private async withEmergencyServices(
    tx: IncidentWriteTransaction,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return { ...body, emergency_services: await this.repository.emergencyServices(tx) };
  }

  /** Realtime `incident.event` for the events a committed write inserted. Not awaited. */
  private afterEvents(
    incident: { incident_id: string; resident_id: string; circle_id: string | null },
    events: RecordedIncidentEvent[] | undefined,
  ): void {
    if (!events?.length) return;
    void this.postCommit.afterEvents(
      {
        incident_id: incident.incident_id,
        resident_id: incident.resident_id,
        circle_id: incident.circle_id,
      },
      events,
    );
  }

  private recordAudit(
    tx: AuditTransaction,
    user: AuthenticatedUser,
    action: AuditAction,
    incidentId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor_user_id: user.id,
        actor_session_id: auditSessionId(user),
        target_type: 'incident',
        target_id: incidentId,
        detail,
      },
      tx,
    );
  }
}
