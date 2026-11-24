import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { RateLimit, type RateLimitPolicy } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireIncidentId } from './incident-input';
import { statusUpdateFromBody } from './incident-update-input';
import { type IncidentUpdateView, IncidentUpdatesService } from './incident-updates.service';
import {
  incidentIdParamsSchema,
  incidentUpdateListSchema,
  incidentUpdateSchema,
  sendIncidentUpdateRequestSchema,
} from './incident.schemas';

/**
 * D70 (plan decision 4): at most 10 status updates per minute per alert (only the resident can send
 * them, so per caller per incident is per alert). Every request to the route counts, as for every
 * rate limit (API-100-11); it also counts towards the caller's `authenticated` limit.
 */
export const INCIDENT_UPDATE_RATE_LIMIT: RateLimitPolicy = {
  name: 'incident_update',
  max: 10,
  windowSeconds: 60,
  scope: 'user_incident',
  code: 'incident_updates:rate_limited',
};

/** Resident status updates (SCRUM-44, SCRUM-59; decision D70). */
@Controller('incidents')
export class IncidentUpdatesController {
  constructor(private readonly updates: IncidentUpdatesService) {}

  /**
   * The resident sends a status update on their active alert. Checks in order: token (401), the
   * rate limit (429 `incident_updates:rate_limited` with Retry-After), the Idempotency-Key (required;
   * a replay answers the stored response), `{id}` is uuid input (422 `validation:invalid_request`),
   * the body (422 `incident_updates:invalid_update`), then not the caller's incident or unknown →
   * 404 `not_found`, not active → 409 `not_open`.
   */
  @Post(':id/updates')
  @HttpCode(201)
  @Operation('incident_updates')
  @Idempotent('required')
  @RateLimit(INCIDENT_UPDATE_RATE_LIMIT)
  @ApiContract({
    operationId: 'sendIncidentUpdate',
    summary: "Send a status update (a quick preset or free text) on the caller's active alert",
    tag: 'incidents',
    params: incidentIdParamsSchema,
    body: { name: 'SendIncidentUpdateRequest', schema: sendIncidentUpdateRequestSchema },
    responses: {
      201: {
        description:
          "The update was stored. The alert's members get it live (incident.update) and by push.",
        name: 'IncidentUpdate',
        schema: incidentUpdateSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'incident_updates:invalid_update',
      'incident_updates:not_found',
      'incident_updates:not_open',
      'incident_updates:rate_limited',
    ],
  })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
    @Body() body: unknown,
  ): Promise<IncidentUpdateView> {
    const incidentId = requireIncidentId(id);
    return this.updates.send(user, incidentId, statusUpdateFromBody(body));
  }

  /**
   * The alert's status updates, newest first: the resident (any status), or a member passing
   * `incident.memberView` (inside the window while the alert is active, resolved or closed).
   * Anything else, including an unknown id, is 404 `incident_updates:not_found`. Read-only once the
   * alert is resolved or closed. Default authenticated rate limit.
   */
  @Get(':id/updates')
  @Operation('incident_updates')
  @ApiContract({
    operationId: 'listIncidentUpdates',
    summary: "The alert's status updates, newest first",
    tag: 'incidents',
    params: incidentIdParamsSchema,
    responses: {
      200: {
        description: 'Ordered `created_at`, then `id`, newest first.',
        schema: incidentUpdateListSchema,
      },
    },
    errors: ['validation:invalid_request', 'incident_updates:not_found'],
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<IncidentUpdateView[]> {
    return this.updates.list(user, requireIncidentId(id));
  }
}
