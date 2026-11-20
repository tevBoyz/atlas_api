import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { incidentAlias, incidentMemberView, incidentResident } from '../common/policies';
import { DatabaseService } from '../db/database.service';

/** Who a socket is in an incident room it was allowed to join. */
export type IncidentRole = 'resident' | 'member';

/** The decision of one `incident.join` (API-100-40 AC1). */
export interface JoinAccess {
  incident_id: string;
  /** The incident's circle (null only for a resident whose circle is gone). */
  circle_id: string | null;
  role: IncidentRole;
}

/**
 * The authorization of `incident.join` (API-100-40 AC1, AC4): the same policies as the REST incident
 * reads, as one SQL predicate per call (no cached grant). The resident (`incident.resident`, any
 * status) or a member passing `incident.memberView` (circle set, status `active`/`resolved`, an
 * `active` member row whose `activated_at` is not after the incident's `activated_at` (rule 54), not
 * the resident). Pending, declined, removed and left users, members who joined after the incident
 * started, and outsiders get nothing, the same as `GET /v1/incidents/{id}` (`not_found`).
 */
@Injectable()
export class RealtimeAccessRepository {
  constructor(private readonly database: DatabaseService) {}

  async joinAccess(incidentId: string, callerId: string): Promise<JoinAccess | undefined> {
    const incident = incidentAlias('rec');
    const result = await this.database.db.execute<{
      incident_id: string;
      circle_id: string | null;
      is_resident: boolean;
    }>(sql`
      select rec.id::text as incident_id,
             rec.circle_id::text as circle_id,
             ${incidentResident.where({ callerId, incident })} as is_resident
        from public.incidents rec
       where rec.id = ${incidentId}::uuid
         and (${incidentResident.where({ callerId, incident })}
              or ${incidentMemberView.where({ callerId, incident })})`);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      incident_id: row.incident_id,
      circle_id: row.circle_id,
      role: row.is_resident === true ? 'resident' : 'member',
    };
  }
}
