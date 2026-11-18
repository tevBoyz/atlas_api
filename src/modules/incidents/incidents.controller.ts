import { Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation, ZodBody } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { incidentSubmitResultSchema, submitEmergencyAlertRequestSchema } from './incident.schemas';
import { IncidentsService } from './incidents.service';

@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post()
  @Operation('submit_emergency_alert')
  @Idempotent('required')
  @RateLimit('emergency_write')
  @ApiContract({
    operationId: 'submitEmergencyAlert',
    summary: 'Create the emergency alert, or re-notify the one already open',
    tag: 'incidents',
    body: { name: 'SubmitEmergencyAlertRequest', schema: submitEmergencyAlertRequestSchema },
    responses: {
      200: {
        description: 'An alert was already open: its members were re-notified',
        name: 'IncidentSubmitResult',
        schema: incidentSubmitResultSchema,
      },
      201: {
        description: 'The alert was created (or a legacy activating alert was promoted)',
        name: 'IncidentSubmitResult',
        schema: incidentSubmitResultSchema,
      },
    },
    errors: [
      'submit_emergency_alert:invalid_type',
      'submit_emergency_alert:profile_not_found',
      'submit_emergency_alert:profile_setup_incomplete',
    ],
  })
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @ZodBody(submitEmergencyAlertRequestSchema, {
      fallback: 'submit_emergency_alert:invalid_type',
    })
    body: z.output<typeof submitEmergencyAlertRequestSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const result = await this.incidents.submit(user, body.emergency_type);
    void reply.status(result.status);
    return result.body;
  }
}
