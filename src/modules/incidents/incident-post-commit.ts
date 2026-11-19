import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { ROOT_LOGGER } from '../../observability/logger';
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
 * Work that follows a committed incident write: realtime (API-100-41) and the outbox (API-100-48).
 * A hook implements the events it cares about.
 */
export interface IncidentPostCommitHook {
  afterSubmit?(event: IncidentSubmittedEvent): void | Promise<void>;
  afterLocation?(event: IncidentLocationEvent): void | Promise<void>;
  afterNotes?(event: IncidentNotesEvent): void | Promise<void>;
  afterRenotify?(event: IncidentRenotifiedEvent): void | Promise<void>;
}

/** The registered hooks. Empty until API-100-41 and API-100-48 add theirs. */
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
