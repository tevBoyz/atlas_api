import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { IncidentPostCommitRunner } from '../incidents/incident-post-commit';
import { IncidentsRepository } from '../incidents/incidents.repository';
import {
  IncidentOperationFailedError,
  runIncidentTransaction,
} from '../incidents/incident-transaction';
import { assertArgumentsConvert, type ParsedAttachLocation, pendingChecks } from './location-input';
import { LocationsRepository } from './locations.repository';

/**
 * `POST /v1/incidents/{id}/locations`, the API form of `attach_incident_location` (spec §6.6, rules
 * 33-36). One transaction, in the function's order: argument conversion and checks (no table read),
 * then the caller's incident `FOR UPDATE` (`not_found`), `active` with sharing not ended (`not_open`),
 * the out-of-order guard and the write. Never notifies, never touches deliveries, status, type or
 * notes. The database stays the source of truth: there is no location cache.
 *
 * Coordinates are never logged, audited or put in an error: they exist only as bound parameters and
 * in the response body. There is no audit row (spec §11.3 H3 lists incident writes; a ping every 12 s
 * per resident is not recorded, see the story report).
 */
@Injectable()
export class LocationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly incidents: IncidentsRepository,
    private readonly locations: LocationsRepository,
    private readonly postCommit: IncidentPostCommitRunner,
  ) {}

  async attach(
    user: AuthenticatedUser,
    incidentId: string,
    input: ParsedAttachLocation,
  ): Promise<Record<string, unknown>> {
    const result = await runIncidentTransaction(
      this.database,
      async (tx) => {
        await this.locations.useInputSettings(tx);

        const checks = pendingChecks(input.conversions);
        assertArgumentsConvert(input.conversions, await this.locations.inputValidity(tx, checks));

        const error = await this.locations.checkArguments(tx, input.args);
        if (error) throw new DomainError(`attach_incident_location:${error}`);

        const incident = await this.incidents.lockOwnIncident(tx, incidentId, user.id);
        if (!incident) throw new DomainError('attach_incident_location:not_found');
        // Late pings after mark safe never write and never reopen (rule 33).
        if (incident.status !== 'active' || incident.sharing_ended) {
          throw new DomainError('attach_incident_location:not_open');
        }

        const written = await this.locations.writeLocation(tx, incident.id, input.args);
        if (written) return { incidentId: incident.id, body: written, applied: true };
        // An older fix: keep the newer one and answer with the current row (rule 34).
        return {
          incidentId: incident.id,
          body: await this.incidents.sharedResult(tx, incident.id),
          applied: false,
        };
      },
      (sqlState) => new IncidentOperationFailedError('attach_incident_location', sqlState),
    );
    if (result.applied) {
      void this.postCommit.afterLocation({
        incident_id: result.incidentId,
        resident_id: user.id,
        circle_id: result.body.circle_id as string | null,
      });
    }
    return result.body;
  }
}
