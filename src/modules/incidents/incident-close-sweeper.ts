import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Logger } from 'pino';

import { DatabaseService } from '../../db/database.service';
import { JobQueues } from '../../jobs/job-queues.service';
import { JobFailedError, type JobProcessor, jobErrorCode } from '../../jobs/job-workers';
import {
  INCIDENT_CLOSE_SWEEP_EVERY_MS,
  INCIDENT_CLOSE_SWEEP_JOB_OPTIONS,
  INCIDENT_CLOSE_SWEEP_SCHEDULER_ID,
  INCIDENT_LIFECYCLE_QUEUE,
} from '../../jobs/jobs.constants';
import { ROOT_LOGGER } from '../../observability/logger';
import { AuditService } from '../audit';
import { readIncidentCloseSettings } from './incident-close-settings';
import { IncidentEventService, type RecordedIncidentEvent } from './incident-events.service';
import { IncidentPostCommitRunner } from './incident-post-commit';
import { type ClosedIncident, IncidentStateService } from './incident-state.service';

/** Incidents closed per transaction; a full batch is followed by another one in the same sweep. */
export const INCIDENT_CLOSE_SWEEP_BATCH = 100;

interface ClosedBatch {
  closed: ClosedIncident[];
  events: RecordedIncidentEvent[];
  /** How many rows were claimed (a full claim means there may be more). */
  claimed: number;
}

/**
 * The incident close sweeper (SCRUM-63, D62): ONE repeatable BullMQ job
 * (`incident-close-sweep`, every minute, queue `incident-lifecycle`) that the worker process
 * (`WORKER=1`) schedules at start and runs. Each run closes everything that is due, through the state
 * service (D61):
 * - Resolved (Safe) -> Closed `incident_close_after_minutes` (app_config, default 30) after
 *   `resolved_at`;
 * - Active -> Closed (`ended`, `auto_closed`) after `incident_auto_close_after_hours` (default 24)
 *   without activity; location sharing ends as at mark safe.
 *
 * Safe to run twice at once (two workers, or a run that overlaps the next): rows are claimed
 * `FOR UPDATE SKIP LOCKED` and each close re-checks the row in its `where`, so an incident is closed
 * once. Idempotent: a closed incident is never due again. Lock order: the sweeper locks only incident
 * rows, never waits for a lock (SKIP LOCKED), and writes no profile foreign key (its events have no
 * actor) and no delivery row, so it adds no deadlock path with mark safe (profile -> incident),
 * a location ping (incident) or acknowledge / response (delivery row).
 *
 * After each committed batch: `incident.closed` (and `incident.updated`, `incident.event`) to the
 * incident room, the recipients' and the resident's user rooms. No push, SMS or email, and no
 * notification outbox row. One audit row `incident.closed` per incident (no actor).
 */
@Injectable()
export class IncidentCloseSweeper implements JobProcessor, OnApplicationBootstrap {
  readonly queue = INCIDENT_LIFECYCLE_QUEUE;

  constructor(
    private readonly database: DatabaseService,
    private readonly state: IncidentStateService,
    private readonly events: IncidentEventService,
    private readonly audit: AuditService,
    private readonly postCommit: IncidentPostCommitRunner,
    private readonly queues: JobQueues,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Registers (or updates) the job scheduler. Idempotent: every worker does it at start and BullMQ
   * keeps one scheduler, so one sweep job runs per minute however many workers there are. Not
   * awaited by startup: a down Redis is retried by BullMQ's connection and logged.
   */
  onApplicationBootstrap(): void {
    if (!this.queues.isConfigured) return;
    void this.schedule().catch((err: unknown) => {
      this.logger.warn({ err }, 'incident close sweep could not be scheduled');
    });
  }

  async schedule(): Promise<void> {
    await this.queues.queue(INCIDENT_LIFECYCLE_QUEUE).upsertJobScheduler(
      INCIDENT_CLOSE_SWEEP_SCHEDULER_ID,
      { every: INCIDENT_CLOSE_SWEEP_EVERY_MS },
      {
        name: INCIDENT_CLOSE_SWEEP_SCHEDULER_ID,
        data: {},
        opts: INCIDENT_CLOSE_SWEEP_JOB_OPTIONS,
      },
    );
  }

  /** The one job of the queue: a sweep (the job carries no data). */
  async process(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      throw new JobFailedError(jobErrorCode(error));
    }
  }

  /** Closes every incident that is due now. Returns what it closed (tests, logs). */
  async sweep(): Promise<ClosedIncident[]> {
    const all: ClosedIncident[] = [];
    for (;;) {
      const batch = await this.closeBatch();
      all.push(...batch.closed);
      this.afterCommit(batch);
      if (batch.claimed < INCIDENT_CLOSE_SWEEP_BATCH) break;
    }
    if (all.length > 0) {
      this.logger.info(
        {
          closed: all.length,
          resolved_closed: all.filter((c) => c.from === 'resolved').length,
          auto_closed: all.filter((c) => c.from === 'active').length,
        },
        'incident close sweep closed incidents',
      );
    }
    return all;
  }

  private closeBatch(): Promise<ClosedBatch> {
    return this.database.db.transaction(async (tx) => {
      const settings = await readIncidentCloseSettings(tx);
      const claimed = await this.state.claimDue(tx, settings, INCIDENT_CLOSE_SWEEP_BATCH);
      const closed: ClosedIncident[] = [];
      for (const row of claimed) {
        const done = await this.state.closeDue(tx, row, settings);
        if (!done) continue;
        closed.push(done);
        // Ids, the reason and the flag only (API-100-14 AC4).
        await this.audit.record(
          {
            action: 'incident.closed',
            actor_user_id: null,
            target_type: 'incident',
            target_id: done.id,
            detail: {
              resident_id: done.resident_id,
              circle_id: done.circle_id,
              reason: done.resolved_reason,
              auto_closed: done.auto_closed,
              previous_status: done.from,
            },
          },
          tx,
        );
      }
      return { closed, events: this.events.drain(tx), claimed: claimed.length };
    });
  }

  /** Realtime after the commit; never awaited, never fails the sweep. */
  private afterCommit(batch: ClosedBatch): void {
    for (const incident of batch.closed) {
      const ref = {
        incident_id: incident.id,
        resident_id: incident.resident_id,
        circle_id: incident.circle_id,
      };
      void this.postCommit.afterClosed({ ...ref, from: incident.from });
      const events = batch.events.filter((event) => event.incident_id === incident.id);
      if (events.length > 0) void this.postCommit.afterEvents(ref, events);
    }
  }
}
