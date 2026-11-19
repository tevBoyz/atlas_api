import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DatabaseService } from '../../db/database.service';
import { clampRecentIncidentsLimit } from './incident.schemas';
import { type IncidentTransaction, IncidentsRepository } from './incidents.repository';

/**
 * The resident's own incident reads (spec §6.4, §7.4): `get_my_open_incident` and
 * `list_my_recent_incidents`. Read-only transactions in UTC, so timestamps are the same text submit
 * returns. Rule `incident.resident`: only the caller's own incidents, never a member's view.
 */
@Injectable()
export class IncidentReadsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IncidentsRepository,
  ) {}

  /** `GET /v1/me/incidents/open` (epic §18 D2: always the wrapper). */
  async openIncident(user: AuthenticatedUser): Promise<{ open_incident: unknown }> {
    const body = await this.read((tx) => this.repository.openIncident(tx, user.id));
    return { open_incident: body };
  }

  /** `GET /v1/me/incidents?limit=`. */
  recentIncidents(user: AuthenticatedUser, limit: number | undefined): Promise<unknown[]> {
    const clamped = clampRecentIncidentsLimit(limit);
    return this.read((tx) => this.repository.recentIncidents(tx, user.id, clamped));
  }

  private read<T>(query: (tx: IncidentTransaction) => Promise<T>): Promise<T> {
    return this.database.db.transaction(
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        return query(tx);
      },
      { accessMode: 'read only' },
    );
  }
}
