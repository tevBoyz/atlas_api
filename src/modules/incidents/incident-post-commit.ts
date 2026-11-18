import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { ROOT_LOGGER } from '../../observability/logger';
import type { SubmitOutcome } from './incident.schemas';

/**
 * What a post-commit hook learns about a submit. Identifiers and counts only: a hook that needs more
 * reads it from the database, so emergency and medical data never travel through this seam.
 */
export interface IncidentSubmittedEvent {
  incident_id: string;
  resident_id: string;
  circle_id: string | null;
  submit_outcome: SubmitOutcome;
  recipient_count: number;
}

/** Work that follows a committed submit: realtime (API-100-41) and the outbox (API-100-48). */
export interface IncidentPostCommitHook {
  afterSubmit(event: IncidentSubmittedEvent): void | Promise<void>;
}

/** The registered hooks. Empty until API-100-41 and API-100-48 add theirs. */
export const INCIDENT_POST_COMMIT_HOOKS = Symbol('INCIDENT_POST_COMMIT_HOOKS');

/**
 * Runs the hooks of a submit that has committed. The alert is already saved at this point, so a hook
 * can neither fail nor delay it: the caller does not wait for the result, and a hook that throws or
 * rejects is logged and otherwise ignored.
 */
@Injectable()
export class IncidentPostCommitRunner {
  constructor(
    @Inject(INCIDENT_POST_COMMIT_HOOKS) private readonly hooks: readonly IncidentPostCommitHook[],
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /** Never rejects. Resolves when every hook has finished. */
  async afterSubmit(event: IncidentSubmittedEvent): Promise<void> {
    await Promise.all(
      this.hooks.map(async (hook) => {
        try {
          await hook.afterSubmit(event);
        } catch (err) {
          this.logger.warn(
            { err, incident_id: event.incident_id },
            'incident post-commit hook failed',
          );
        }
      }),
    );
  }
}
