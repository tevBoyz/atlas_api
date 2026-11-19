import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import type { IncidentTransaction } from './incidents.repository';
import { IncidentsRepository } from './incidents.repository';
import { ResponderIncidentsRepository } from './responder-incidents.repository';

/**
 * A circle member's incident reads (API-100-21): `GET /v1/responder/incidents`
 * (`list_responder_incidents`) and `GET /v1/incidents/{id}` (`get_incident_details`). Read-only
 * transactions in UTC, so timestamps are the text the SQL functions return on the hosted database.
 */
@Injectable()
export class ResponderIncidentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly incidents: IncidentsRepository,
    private readonly repository: ResponderIncidentsRepository,
  ) {}

  list(user: AuthenticatedUser): Promise<Record<string, unknown>[]> {
    return this.read((tx) => this.repository.list(tx, user.id));
  }

  /** Hidden existence: every denied read is `get_incident_details:not_found`, as an unknown id. */
  async details(user: AuthenticatedUser, incidentId: string): Promise<Record<string, unknown>> {
    const body = await this.read((tx) => this.repository.details(tx, incidentId, user.id));
    if (!body) throw new DomainError('get_incident_details:not_found');
    return body;
  }

  private read<T>(query: (tx: IncidentTransaction) => Promise<T>): Promise<T> {
    return this.database.db.transaction(
      async (tx) => {
        await this.incidents.useUtcTimestamps(tx);
        return query(tx);
      },
      { accessMode: 'read only' },
    );
  }
}
