import { Controller, Get, Param } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { IncidentEventService } from './incident-events.service';
import { requireIncidentId } from './incident-input';
import { incidentEventListSchema, incidentIdParamsSchema } from './incident.schemas';

/**
 * The incident's event log (API-100-22, spec §11.3 E11). New: the app does not read events today; a
 * foundation for the timeline, history and activity log (spec §15). Read-only: default authenticated
 * rate limit, no Idempotency-Key.
 */
@Controller('incidents')
export class IncidentEventsController {
  constructor(private readonly events: IncidentEventService) {}

  /**
   * `incident.eventsView`: the resident, or an active member inside the window (rule 54) while the
   * incident is `active`/`resolved`. Anything else, including an unknown id, is 404
   * `incident_events:not_found`. A caller who is not the resident gets `alert_sent` and
   * `closure_notified` without `recipient_ids` (epic §18 D3); `recipient_count` stays.
   */
  @Get(':id/events')
  @Operation('incident_events')
  @ApiContract({
    operationId: 'listIncidentEvents',
    summary: "The alert's event log, oldest first",
    tag: 'incidents',
    params: incidentIdParamsSchema,
    responses: {
      200: {
        description:
          'Ordered `occurred_at`, then `id`. For members, `detail.recipient_ids` is left out.',
        schema: incidentEventListSchema,
      },
    },
    errors: ['validation:invalid_request', 'incident_events:not_found'],
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<Record<string, unknown>[]> {
    return this.events.read(user, requireIncidentId(id));
  }
}
