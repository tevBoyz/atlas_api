import { Controller, Get } from '@nestjs/common';
import type { z } from 'zod';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation, ZodQuery } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { IncidentReadsService } from './incident-reads.service';
import {
  openIncidentResultSchema,
  recentIncidentListSchema,
  recentIncidentsQuerySchema,
} from './incident.schemas';

/** The caller's own incidents (resident side). Read-only: default rate limit, no Idempotency-Key. */
@Controller('me/incidents')
export class MeIncidentsController {
  constructor(private readonly reads: IncidentReadsService) {}

  @Get('open')
  @Operation('get_my_open_incident')
  @ApiContract({
    operationId: 'getMyOpenIncident',
    summary:
      'The active incident of the caller, to restore Alert Sent after a restart or a lost response',
    tag: 'incidents',
    responses: {
      200: {
        description: '`open_incident` is the active incident, or null when there is none',
        name: 'OpenIncidentResult',
        schema: openIncidentResultSchema,
      },
    },
  })
  openIncident(@CurrentUser() user: AuthenticatedUser): Promise<{ open_incident: unknown }> {
    return this.reads.openIncident(user);
  }

  @Get()
  @Operation('list_my_recent_incidents')
  @ApiContract({
    operationId: 'listMyRecentIncidents',
    summary: 'The active and resolved incidents of the caller, newest first',
    tag: 'incidents',
    query: recentIncidentsQuerySchema,
    responses: {
      200: {
        description:
          'Newest `activated_at` first; legacy cancelled/activating incidents are left out',
        schema: recentIncidentListSchema,
      },
    },
    errors: ['validation:invalid_request'],
  })
  recentIncidents(
    @CurrentUser() user: AuthenticatedUser,
    @ZodQuery(recentIncidentsQuerySchema) query: z.output<typeof recentIncidentsQuerySchema>,
  ): Promise<unknown[]> {
    return this.reads.recentIncidents(user, query.limit);
  }
}
