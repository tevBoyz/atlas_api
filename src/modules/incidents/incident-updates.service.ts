import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { incidentAlias, incidentMemberView, incidentResident } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit';
import { IncidentNotificationsOutbox } from '../notifications/incident-notifications';
import { IncidentEventService } from './incident-events.service';
import { IncidentPostCommitRunner } from './incident-post-commit';
import { IncidentOperationFailedError, runIncidentTransaction } from './incident-transaction';
import type { StatusUpdateInput } from './incident-update-input';
import type { IncidentTransaction } from './incidents.repository';
import { IncidentsRepository } from './incidents.repository';
import { auditSessionId } from './incidents.service';

/** One status update as the API shows it (D70): exactly these keys, never an id of a person. */
export interface IncidentUpdateView {
  id: string;
  preset: string | null;
  text: string | null;
  created_at: string;
}

/**
 * The view of one `status_update` event row `e` (the transaction runs in UTC). `json`, not `jsonb`:
 * the keys keep this order (as `incident.update` sends them).
 */
const UPDATE_JSON = sql`json_build_object(
    'id', e.id,
    'preset', e.detail->>'preset',
    'text', e.detail->>'text',
    'created_at', e.occurred_at
  )`;

/**
 * Resident status updates (SCRUM-44 Send Status Updates, SCRUM-59 Resident Status Updates
 * (Broadcast); decision D70). An update is one `incident_events` row of type `status_update`
 * (detail `{preset}` or `{text}`), so the activity feed (SCRUM-60/61) lists it with the other events.
 */
@Injectable()
export class IncidentUpdatesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IncidentsRepository,
    private readonly events: IncidentEventService,
    private readonly notifications: IncidentNotificationsOutbox,
    private readonly audit: AuditService,
    private readonly postCommit: IncidentPostCommitRunner,
  ) {}

  /**
   * `POST /v1/incidents/{id}/updates`, in one transaction:
   * 1. `FOR KEY SHARE` on the caller's profile, then the caller's own incident `FOR UPDATE` (the lock
   *    order of submit, re-notify and mark safe: no deadlock with them; a concurrent mark safe is
   *    ordered before or after this update, never in between);
   * 2. not the caller's incident (a member, an outsider, an unknown id) → 404 `not_found`; not
   *    `active` (resolved, closed, a legacy status) → 409 `not_open`;
   * 3. the `status_update` event (server time), the `incident.status_update` outbox row (push to the
   *    alert's recipients) and the audit row `incident.update_sent` (ids, the preset or the text
   *    length: never the text).
   * After the commit: realtime `incident.event` and `incident.update` to the incident room, and the
   * outbox relay is kicked (the response never waits for either).
   */
  async send(
    user: AuthenticatedUser,
    incidentId: string,
    input: StatusUpdateInput,
  ): Promise<IncidentUpdateView> {
    const done = await runIncidentTransaction(
      this.database,
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        await this.repository.keyShareProfile(tx, user.id);
        const incident = await this.repository.lockOwnIncident(tx, incidentId, user.id);
        if (!incident) throw new DomainError('incident_updates:not_found');
        if (incident.status !== 'active') throw new DomainError('incident_updates:not_open');

        const detail = 'preset' in input ? { preset: input.preset } : { text: input.text };
        const event = await this.events.record(tx, incident.id, 'status_update', user.id, detail);
        // `status_update` is not a once-only type: the insert always returns its row.
        if (!event) throw new Error('incident_updates: event not recorded');
        await this.notifications.statusUpdate(tx, incident.id, event.id);
        await this.audit.record(
          {
            action: 'incident.update_sent',
            actor_user_id: user.id,
            actor_session_id: auditSessionId(user),
            target_type: 'incident',
            target_id: incident.id,
            detail: {
              update_id: event.id,
              preset: 'preset' in input ? input.preset : null,
              text_length: 'text' in input ? [...input.text].length : null,
            },
          },
          tx,
        );
        const written = await this.readOne(tx, event.id);
        return { ...written, events: this.events.drain(tx) };
      },
      (sqlState) => new IncidentOperationFailedError('incident_updates', sqlState),
    );
    void this.postCommit.afterEvents(
      { incident_id: incidentId, resident_id: user.id, circle_id: done.circle_id },
      done.events,
    );
    return done.update;
  }

  /**
   * `GET /v1/incidents/{id}/updates`: the incident's status updates, newest first (`created_at`, then
   * `id`, descending), for the resident or a member passing `incident.memberView` (an active member
   * inside the window while the incident is active, resolved or closed: the access of the other
   * incident reads). Read-only transaction in UTC; one statement, so the access check and the rows
   * come from one snapshot. Anyone else, including an unknown id, → 404 `not_found`.
   */
  async list(user: AuthenticatedUser, incidentId: string): Promise<IncidentUpdateView[]> {
    const incident = incidentAlias('rec');
    const callerId = user.id;
    const body = await this.database.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        const result = await tx.execute<{ body: IncidentUpdateView[] }>(sql`
          select coalesce(
                   (select json_agg(${UPDATE_JSON} order by e.occurred_at desc, e.id desc)
                      from public.incident_events e
                     where e.incident_id = rec.id
                       and e.event_type = 'status_update'),
                   '[]'::json
                 ) as body
            from public.incidents rec
           where rec.id = ${incidentId}::uuid
             and (${incidentResident.where({ callerId, incident })}
                  or ${incidentMemberView.where({ callerId, incident })})`);
        return result.rows[0]?.body;
      },
      { accessMode: 'read only' },
    );
    if (!body) throw new DomainError('incident_updates:not_found');
    return body;
  }

  private async readOne(
    tx: IncidentTransaction,
    eventId: string,
  ): Promise<{ update: IncidentUpdateView; circle_id: string | null }> {
    const result = await tx.execute<{ body: IncidentUpdateView; circle_id: string | null }>(sql`
      select ${UPDATE_JSON} as body, i.circle_id::text as circle_id
        from public.incident_events e
        join public.incidents i on i.id = e.incident_id
       where e.id = ${eventId}::uuid`);
    const row = result.rows[0];
    return { update: row.body, circle_id: row.circle_id };
  }
}
