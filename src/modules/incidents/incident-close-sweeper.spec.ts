import type { Logger } from 'pino';

import type { DatabaseService } from '../../db/database.service';
import type { JobQueues } from '../../jobs/job-queues.service';
import { JobFailedError } from '../../jobs/job-workers';
import {
  INCIDENT_CLOSE_SWEEP_EVERY_MS,
  INCIDENT_CLOSE_SWEEP_SCHEDULER_ID,
  INCIDENT_LIFECYCLE_QUEUE,
} from '../../jobs/jobs.constants';
import type { AuditService } from '../audit';
import { INCIDENT_CLOSE_SWEEP_BATCH, IncidentCloseSweeper } from './incident-close-sweeper';
import type { IncidentEventService } from './incident-events.service';
import type { IncidentPostCommitRunner } from './incident-post-commit';
import type { ClaimedIncident, IncidentStateService } from './incident-state.service';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';

function closed(id: string, from: 'active' | 'resolved') {
  return {
    id,
    resident_id: `r-${id}`,
    circle_id: `c-${id}`,
    from,
    resolved_reason: from === 'active' ? 'ended' : 'safe',
    auto_closed: from === 'active',
  };
}

function setup() {
  const order: string[] = [];
  const settingsRow = { rows: [{ minutes: 30, hours: 24 }] };
  const tx = { execute: jest.fn().mockResolvedValue(settingsRow) };
  const database = {
    db: {
      transaction: jest.fn(async (run: (t: object) => Promise<unknown>) => {
        const result = await run(tx);
        order.push('commit');
        return result;
      }),
    },
  };
  const state = {
    claimDue: jest.fn().mockResolvedValue([
      { id: A, status: 'resolved' },
      { id: B, status: 'active' },
    ] satisfies ClaimedIncident[]),
    closeDue: jest.fn((_tx: unknown, row: ClaimedIncident) =>
      Promise.resolve(closed(row.id, row.status)),
    ),
  };
  const recorded = [
    { id: 'e1', incident_id: A, event_type: 'incident_closed' },
    { id: 'e2', incident_id: B, event_type: 'location_sharing_ended' },
    { id: 'e3', incident_id: B, event_type: 'incident_closed' },
  ];
  const events = { drain: jest.fn().mockReturnValue(recorded) };
  const audit = {
    record: jest.fn(() => {
      order.push('audit');
      return Promise.resolve();
    }),
  };
  const postCommit = {
    afterClosed: jest.fn(() => {
      order.push('closed-hook');
      return Promise.resolve();
    }),
    afterEvents: jest.fn().mockResolvedValue(undefined),
  };
  const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
  const queues = {
    isConfigured: true,
    queue: jest.fn().mockReturnValue({ upsertJobScheduler }),
  };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const sweeper = new IncidentCloseSweeper(
    database as unknown as DatabaseService,
    state as unknown as IncidentStateService,
    events as unknown as IncidentEventService,
    audit as unknown as AuditService,
    postCommit as unknown as IncidentPostCommitRunner,
    queues as unknown as JobQueues,
    logger as unknown as Logger,
  );
  return { sweeper, database, state, events, audit, postCommit, queues, upsertJobScheduler, order };
}

describe('IncidentCloseSweeper (SCRUM-63, D62)', () => {
  it('runs on the incident-lifecycle queue', () => {
    expect(setup().sweeper.queue).toBe(INCIDENT_LIFECYCLE_QUEUE);
  });

  it('schedules ONE repeatable job every minute (no per-incident job)', async () => {
    const { sweeper, queues, upsertJobScheduler } = setup();
    await sweeper.schedule();
    expect(queues.queue).toHaveBeenCalledWith(INCIDENT_LIFECYCLE_QUEUE);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      INCIDENT_CLOSE_SWEEP_SCHEDULER_ID,
      { every: INCIDENT_CLOSE_SWEEP_EVERY_MS },
      expect.objectContaining({ name: INCIDENT_CLOSE_SWEEP_SCHEDULER_ID }),
    );
    expect(INCIDENT_CLOSE_SWEEP_EVERY_MS).toBe(60_000);
  });

  it('closes what is due, audits each close (ids, reason, flag), hooks only after the commit', async () => {
    const { sweeper, audit, postCommit, order } = setup();
    const done = await sweeper.sweep();
    expect(done.map((c) => c.id)).toEqual([A, B]);
    expect(audit.record).toHaveBeenCalledWith(
      {
        action: 'incident.closed',
        actor_user_id: null,
        target_type: 'incident',
        target_id: B,
        detail: {
          resident_id: `r-${B}`,
          circle_id: `c-${B}`,
          reason: 'ended',
          auto_closed: true,
          previous_status: 'active',
        },
      },
      expect.anything(),
    );
    expect(order).toEqual(['audit', 'audit', 'commit', 'closed-hook', 'closed-hook']);
    expect(postCommit.afterClosed).toHaveBeenCalledWith({
      incident_id: A,
      resident_id: `r-${A}`,
      circle_id: `c-${A}`,
      from: 'resolved',
    });
    // Each incident's own events, in their order.
    expect(postCommit.afterEvents).toHaveBeenCalledWith(
      { incident_id: B, resident_id: `r-${B}`, circle_id: `c-${B}` },
      [
        { id: 'e2', incident_id: B, event_type: 'location_sharing_ended' },
        { id: 'e3', incident_id: B, event_type: 'incident_closed' },
      ],
    );
  });

  it('a claimed row that is no longer due is skipped: no audit, no hook', async () => {
    const { sweeper, state, audit, postCommit } = setup();
    state.closeDue.mockResolvedValue(undefined as never);
    await expect(sweeper.sweep()).resolves.toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
    expect(postCommit.afterClosed).not.toHaveBeenCalled();
  });

  it('a full batch is followed by another one; a short batch ends the sweep', async () => {
    const { sweeper, state, database } = setup();
    const full = Array.from({ length: INCIDENT_CLOSE_SWEEP_BATCH }, (_, i) => ({
      id: `id-${i}`,
      status: 'resolved' as const,
    }));
    state.claimDue.mockResolvedValueOnce(full).mockResolvedValueOnce([]);
    const done = await sweeper.sweep();
    expect(done).toHaveLength(INCIDENT_CLOSE_SWEEP_BATCH);
    expect(database.db.transaction).toHaveBeenCalledTimes(2);
  });

  it('a failed sweep fails the job with a code only (never the original error)', async () => {
    const { sweeper, database } = setup();
    database.db.transaction.mockRejectedValue(Object.assign(new Error('boom'), { code: '40P01' }));
    const error: unknown = await sweeper.process().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobFailedError);
    expect(error).toMatchObject({ errorCode: 'sqlstate_40P01' });
  });

  it('without Redis nothing is scheduled', () => {
    const { sweeper, queues } = setup();
    queues.isConfigured = false;
    sweeper.onApplicationBootstrap();
    expect(queues.queue).not.toHaveBeenCalled();
  });
});
