import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireIncidentId } from './incident-input';
import type { ResponderView } from './incident-responder-view';
import { IncidentRespondersService, responseStatusFromBody } from './incident-responders.service';
import {
  incidentIdParamsSchema,
  incidentResponseRequestSchema,
  responderListSchema,
  responderSchema,
} from './incident.schemas';

/**
 * Responder status (SCRUM-49/50/51/55, decision D56). Both routes use the default authenticated rate
 * limit. No Idempotency-Key: a response is idempotent in the domain (the same status again writes
 * nothing and keeps its time).
 */
@Controller('incidents')
export class IncidentRespondersController {
  constructor(private readonly responders: IncidentRespondersService) {}

  /**
   * A notified member says they are responding or unable to respond. Checks in order: `{id}` is uuid
   * input, the body is a JSON object (422 `validation:invalid_request`), `status` is `responding` or
   * `unable` (422 `invalid_status`); then no delivery row for the caller, or the caller does not pass
   * `incident.memberView` (including an unknown id) → 404 `not_found`; the incident is not `active`
   * → 409 `not_open`. Switching between the two statuses is allowed; it also acknowledges the alert
   * when it was not acknowledged yet.
   */
  @Post(':id/response')
  @HttpCode(200)
  @Operation('incident_response')
  @ApiContract({
    operationId: 'setIncidentResponse',
    summary: "Set the caller's response to the alert: responding or unable to respond",
    tag: 'incidents',
    params: incidentIdParamsSchema,
    body: { name: 'IncidentResponseRequest', schema: incidentResponseRequestSchema },
    responses: {
      200: {
        description:
          "The caller's own responder row (set now, or unchanged when the status was already set)",
        name: 'Responder',
        schema: responderSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'incident_response:invalid_status',
      'incident_response:not_found',
      'incident_response:not_open',
    ],
  })
  respond(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
    @Body() body: unknown,
  ): Promise<ResponderView> {
    const incidentId = requireIncidentId(id);
    return this.responders.respond(user, incidentId, responseStatusFromBody(body));
  }

  /**
   * The responder list: the resident (any status), or a member inside the window while the incident
   * is `active` / `resolved` (`incident.eventsView`). Anything else, including an unknown id, is 404
   * `incident_responders:not_found`. Members see other members' user ids obscured (D11 style).
   */
  @Get(':id/responders')
  @Operation('incident_responders')
  @ApiContract({
    operationId: 'listIncidentResponders',
    summary: 'Every notified member with their response status, responding first',
    tag: 'incidents',
    params: incidentIdParamsSchema,
    responses: {
      200: {
        description:
          'Responding, then acknowledged, then unable, then no response; each oldest first. Members whose membership ended are left out.',
        schema: responderListSchema,
      },
    },
    errors: ['validation:invalid_request', 'incident_responders:not_found'],
  })
  list(@CurrentUser() user: AuthenticatedUser, @Param('id') id: unknown): Promise<ResponderView[]> {
    return this.responders.list(user, requireIncidentId(id));
  }
}
