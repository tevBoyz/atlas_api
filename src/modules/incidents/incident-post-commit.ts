import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { ROOT_LOGGER } from '../../observability/logger';
import type { IncidentEventType } from './incident-events.service';
import type { SubmitOutcome } from './incident.schemas';

/**
 * What post-commit hooks learn about a committed incident write. Identifiers and counts only: a hook
 * that needs more reads it from the database, so emergency and medical data, notes and coordinates
 * never travel through this seam.
 */
interface IncidentRef {
  incident_id: string;
  resident_id: string;
  circle_id: string | null;
}

/** A committed `POST /v1/incidents` (API-100-15). */
export interface IncidentSubmittedEvent extends IncidentRef {
  submit_outcome: SubmitOutcome;
  recipient_count: number;
}

/**
 * Realtime `incident.location` (API-100-17): a location ping was stored. Not raised for a ping the
 * out-of-order guard ignored (nothing changed).
 */
export type IncidentLocationEvent = IncidentRef;

/** Realtime `incident.notes` (API-100-18): the live note was set or cleared. */
export interface IncidentNotesEvent extends IncidentRef {
  cleared: boolean;
}

/** Realtime `incident.renotified` (API-100-18): `POST /v1/incidents/{id}/renotify` committed. */
export interface IncidentRenotifiedEvent extends IncidentRef {
  recipient_count: number;
}

/**
 * `incident.resolved` (API-100-19): `POST /v1/incidents/{id}/mark-safe` closed the incident. Raised
 * once per incident, by the call that closed it: never for the already-safe no-op, an error or an
 * idempotent replay. Realtime (API-100-41) tells the incident room; the outbox (API-100-48) enqueues
 * the closure notice for each recipient (it reads the recipients from `closure_notified`).
 */
export interface IncidentResolvedEvent extends IncidentRef {
  recipient_count: number;
}

/**
 * Realtime `incident.delivery_counts` to the resident (API-100-20, API-100-41): a member's first
 * acknowledge changed the counts. Not raised for a repeat acknowledge (nothing changed), an error or a
 * counts read.
 */
export interface IncidentDeliveryCountsEvent extends IncidentRef {
  delivered_count: number;
  acknowledged_count: number;
}

/**
 * Realtime `incident.event` (API-100-22, API-100-41): one `incident_events` row was inserted by a
 * committed write (submit, re-notify, mark safe), in insertion order. Never raised for a once-only
 * event that was already there (`ON CONFLICT DO NOTHING`). The detail is not carried: a hook that
 * needs it reads the row, applying `incident.eventsView` and hiding `recipient_ids` from members.
 */
export interface IncidentEventRecordedEvent extends IncidentRef {
  event_id: string;
  event_type: IncidentEventType;
}

/**
 * Realtime `incident.shared_info_updated` (SCRUM-21, D53): the resident changed their emergency info
 * during the incident and its live share payload (`live_share_payload`) was rewritten. Ids only: the
 * hook reads the payload after the commit.
 */
export type IncidentSharedInfoEvent = IncidentRef;

/**
 * Realtime `incident.responders` (SCRUM-49/50/51/55, D56): one member's responder row changed (their
 * first acknowledge, or a new response status). Ids only: the hook reads the row after the commit.
 * Not raised for a repeat that changed nothing, an error or a read.
 */
export interface IncidentRespondersEvent extends IncidentRef {
  member_user_id: string;
}

/**
 * Work that follows a committed incident write: realtime (API-100-41) and the outbox (API-100-48).
 * A hook implements the events it cares about.
 */
export interface IncidentPostCommitHook {
  afterSubmit?(event: IncidentSubmittedEvent): void | Promise<void>;
  afterLocation?(event: IncidentLocationEvent): void | Promise<void>;
  afterNotes?(event: IncidentNotesEvent): void | Promise<void>;
  afterRenotify?(event: IncidentRenotifiedEvent): void | Promise<void>;
  afterResolved?(event: IncidentResolvedEvent): void | Promise<void>;
  afterDeliveryCounts?(event: IncidentDeliveryCountsEvent): void | Promise<void>;
  afterEvent?(event: IncidentEventRecordedEvent): void | Promise<void>;
  afterSharedInfo?(event: IncidentSharedInfoEvent): void | Promise<void>;
  afterResponders?(event: IncidentRespondersEvent): void | Promise<void>;
}

/** The registered hooks: the realtime broadcaster (API-100-41/42); the outbox (API-100-48) later. */
export const INCIDENT_POST_COMMIT_HOOKS = Symbol('INCIDENT_POST_COMMIT_HOOKS');

type HookName = keyof IncidentPostCommitHook;

/**
 * Runs the hooks of a write that has committed. The write is already saved at this point, so a hook
 * can neither fail nor delay it: callers do not wait for the result, and a hook that throws or rejects
 * is logged and otherwise ignored.
 */
@Injectable()
export class IncidentPostCommitRunner {
  constructor(
    @Inject(INCIDENT_POST_COMMIT_HOOKS) private readonly hooks: readonly IncidentPostCommitHook[],
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /** Never rejects. Resolves when every hook has finished. */
  afterSubmit(event: IncidentSubmittedEvent): Promise<void> {
    return this.run('afterSubmit', event, (hook) => hook.afterSubmit?.(event));
  }

  /** `incident.location`. Never rejects. */
  afterLocation(event: IncidentLocationEvent): Promise<void> {
    return this.run('afterLocation', event, (hook) => hook.afterLocation?.(event));
  }

  /** `incident.notes`. Never rejects. */
  afterNotes(event: IncidentNotesEvent): Promise<void> {
    return this.run('afterNotes', event, (hook) => hook.afterNotes?.(event));
  }

  /** `incident.renotified`. Never rejects. */
  afterRenotify(event: IncidentRenotifiedEvent): Promise<void> {
    return this.run('afterRenotify', event, (hook) => hook.afterRenotify?.(event));
  }

  /** `incident.resolved`. Never rejects. */
  afterResolved(event: IncidentResolvedEvent): Promise<void> {
    return this.run('afterResolved', event, (hook) => hook.afterResolved?.(event));
  }

  /** `incident.delivery_counts`. Never rejects. */
  afterDeliveryCounts(event: IncidentDeliveryCountsEvent): Promise<void> {
    return this.run('afterDeliveryCounts', event, (hook) => hook.afterDeliveryCounts?.(event));
  }

  /** `incident.shared_info_updated` (D53). Never rejects. */
  afterSharedInfo(event: IncidentSharedInfoEvent): Promise<void> {
    return this.run('afterSharedInfo', event, (hook) => hook.afterSharedInfo?.(event));
  }

  /** `incident.responders` (D56). Never rejects. */
  afterResponders(event: IncidentRespondersEvent): Promise<void> {
    return this.run('afterResponders', event, (hook) => hook.afterResponders?.(event));
  }

  /**
   * `incident.event`, once per inserted event, in insertion order (each hook sees them in order).
   * Never rejects.
   */
  async afterEvents(
    incident: IncidentRef,
    events: readonly { id: string; event_type: IncidentEventType }[],
  ): Promise<void> {
    for (const recorded of events) {
      const event: IncidentEventRecordedEvent = {
        ...incident,
        event_id: recorded.id,
        event_type: recorded.event_type,
      };
      await this.run('afterEvent', event, (hook) => hook.afterEvent?.(event));
    }
  }

  private async run(
    name: HookName,
    event: IncidentRef,
    call: (hook: IncidentPostCommitHook) => void | Promise<void> | undefined,
  ): Promise<void> {
    await Promise.all(
      this.hooks.map(async (hook) => {
        try {
          await call(hook);
        } catch (err) {
          this.logger.warn(
            { err, hook: name, incident_id: event.incident_id },
            'incident post-commit hook failed',
          );
        }
      }),
    );
  }
}
