import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import type { DeliveryCounts } from './incident-deliveries.repository';
import { IncidentDeliveriesService } from './incident-deliveries.service';
import { requireIncidentId } from './incident-input';
import { deliveryCountsSchema, incidentIdParamsSchema } from './incident.schemas';

/**
 * In-app delivery counts and acknowledge (API-100-20). Both use the default authenticated rate limit
 * (`RATE_LIMIT_AUTHENTICATED_*`, 300 per user per 60 s by default): the app's 2 s counts poll is 30
 * per minute. No Idempotency-Key: acknowledge is idempotent in the domain (a repeat writes nothing).
 */
@Controller('incidents')
export class IncidentDeliveriesController {
  constructor(private readonly deliveries: IncidentDeliveriesService) {}

  /**
   * `incident_delivery_counts`: the resident (any status), or an active member of the incident's circle
   * whose membership started at or before the incident (rule 54) while it is `active`. Anything else,
   * including an unknown id, is 404 `incident_delivery_counts:not_found`.
   */
  @Get(':id/delivery-counts')
  @Operation('incident_delivery_counts')
  @ApiContract({
    operationId: 'incidentDeliveryCounts',
    summary: 'How many members received and acknowledged the alert (in-app)',
    tag: 'incidents',
    params: incidentIdParamsSchema,
    responses: {
      200: {
        description: 'The counts and the current status',
        name: 'DeliveryCounts',
        schema: deliveryCountsSchema,
      },
    },
    errors: ['validation:invalid_request', 'incident_delivery_counts:not_found'],
  })
  counts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<DeliveryCounts> {
    return this.deliveries.counts(user, requireIncidentId(id));
  }

  /**
   * `acknowledge_incident` (server parity; the app UI is Epic 5): a member with a delivery row, still
   * an active member inside the window → 404 `not_found` otherwise; the incident must be `active` →
   * 409 `not_open`. Idempotent: a repeat answers the same counts and writes nothing.
   */
  @Post(':id/acknowledge')
  @HttpCode(200)
  @Operation('acknowledge_incident')
  @ApiContract({
    operationId: 'acknowledgeIncident',
    summary: "Acknowledge the alert as one of its recipients (the caller's own delivery)",
    tag: 'incidents',
    params: incidentIdParamsSchema,
    responses: {
      200: {
        description: 'Acknowledged (now or earlier): the counts and the status',
        name: 'DeliveryCounts',
        schema: deliveryCountsSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'acknowledge_incident:not_found',
      'acknowledge_incident:not_open',
    ],
  })
  acknowledge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<DeliveryCounts> {
    return this.deliveries.acknowledge(user, requireIncidentId(id));
  }
}
