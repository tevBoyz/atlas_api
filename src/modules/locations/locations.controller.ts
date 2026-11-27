import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireIncidentId } from '../incidents/incident-input';
import { incidentIdParamsSchema, incidentSharedSchema } from '../incidents/incident.schemas';
import { placeFromBody } from '../incidents/incident-place';
import { parseAttachLocationBody } from './location-input';
import { attachIncidentLocationRequestSchema } from './location.schemas';
import { LocationsService } from './locations.service';

@Controller('incidents')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  /**
   * `attach_incident_location` (spec §6.6). Checks in order: `{id}` is uuid input, the body is a JSON
   * object and each value converts to its SQL type (422 `validation:invalid_request` naming the
   * field), then the SQL function's checks (422 `invalid_source`, `invalid_location`; 404 `not_found`;
   * 409 `not_open`). An older fix than the stored one is 200 with the current row. Limited per user
   * per incident (`location_ping`). No Idempotency-Key: the out-of-order guard makes a repeat harmless.
   */
  @Post(':id/locations')
  @HttpCode(200)
  @Operation('attach_incident_location')
  @RateLimit('location_ping')
  @ApiContract({
    operationId: 'attachIncidentLocation',
    summary: "Upload the resident's live location to their active alert",
    tag: 'locations',
    params: incidentIdParamsSchema,
    body: { name: 'AttachIncidentLocationRequest', schema: attachIncidentLocationRequestSchema },
    responses: {
      200: {
        description:
          'The incident after the ping (unchanged when the fix was older than the stored one)',
        name: 'IncidentShared',
        schema: incidentSharedSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'attach_incident_location:invalid_source',
      'attach_incident_location:invalid_location',
      'attach_incident_location:not_found',
      'attach_incident_location:not_open',
    ],
  })
  attach(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const incidentId = requireIncidentId(id);
    // Stage 2 [B6] / [B9]: the optional place keys, read leniently (never refuse the fix).
    return this.locations.attach(
      user,
      incidentId,
      parseAttachLocationBody(body),
      placeFromBody(body),
    );
  }
}
