import { Controller, Get, Param } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireIncidentId } from './incident-input';
import {
  incidentDetailsSchema,
  incidentIdParamsSchema,
  responderIncidentListSchema,
} from './incident.schemas';
import { ResponderIncidentsService } from './responder-incidents.service';

/**
 * The incidents a caller can see as a circle member (API-100-21, spec §6.10, rule 54): only while an
 * active member of the incident's circle, and only incidents that started at or after their
 * membership did. Read-only: default authenticated rate limit, no Idempotency-Key.
 */
@Controller()
export class ResponderIncidentsController {
  constructor(private readonly responder: ResponderIncidentsService) {}

  @Get('responder/incidents')
  @Operation('list_responder_incidents')
  @ApiContract({
    operationId: 'listResponderIncidents',
    summary:
      'The alerts of the circles the caller belongs to (from when they joined), newest first',
    tag: 'incidents',
    responses: {
      200: {
        description:
          'Active and resolved alerts, newest `resolved_at`, else `sent_at`, else `activated_at` first; then by id. Not paginated.',
        schema: responderIncidentListSchema,
      },
    },
  })
  list(@CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>[]> {
    return this.responder.list(user);
  }

  /**
   * `get_incident_details`: an active member inside the window, not the resident. Anything else
   * (unknown, the caller's own, pre-join, removed, pending, no circle, a legacy status) is 404
   * `get_incident_details:not_found`.
   */
  @Get('incidents/:id')
  @Operation('get_incident_details')
  @ApiContract({
    operationId: 'getIncidentDetails',
    summary: 'One alert as a circle member sees it (type, location, note, shared fields)',
    tag: 'incidents',
    params: incidentIdParamsSchema,
    responses: {
      200: {
        description: 'The alert, with the fields the resident chose to share',
        name: 'IncidentDetails',
        schema: incidentDetailsSchema,
      },
    },
    errors: ['validation:invalid_request', 'get_incident_details:not_found'],
  })
  details(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<Record<string, unknown>> {
    return this.responder.details(user, requireIncidentId(id));
  }
}
