import { Body, Controller, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation, ZodBody } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { notesFromBody, requireIncidentId } from './incident-input';
import {
  incidentIdParamsSchema,
  incidentSendSchema,
  incidentSharedSchema,
  incidentSubmitResultSchema,
  setIncidentNotesRequestSchema,
  submitEmergencyAlertRequestSchema,
} from './incident.schemas';
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

  /**
   * `set_incident_notes` (spec rule 37). Checks in order: `{id}` is uuid input, the body is a JSON
   * object and `incident_notes` is a string or null (422 `validation:invalid_request`), then the SQL
   * function's checks: not the caller's → 404, not `activating`/`active` → 409 `not_open`, more than
   * 250 characters after trimming → 422 `too_long`. No Idempotency-Key: setting the same note twice
   * leaves the same note.
   */
  @Put(':id/notes')
  @HttpCode(200)
  @Operation('set_incident_notes')
  @ApiContract({
    operationId: 'setIncidentNotes',
    summary: "Set or clear the live note on the caller's open alert",
    tag: 'incidents',
    params: incidentIdParamsSchema,
    body: { name: 'SetIncidentNotesRequest', schema: setIncidentNotesRequestSchema },
    responses: {
      200: {
        description:
          'The note was stored (or cleared); `incident_notes_updated_at` is stamped either way',
        name: 'IncidentShared',
        schema: incidentSharedSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'set_incident_notes:not_found',
      'set_incident_notes:not_open',
      'set_incident_notes:too_long',
    ],
  })
  setNotes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const incidentId = requireIncidentId(id);
    return this.incidents.setNotes(user, incidentId, notesFromBody(body));
  }

  /**
   * `renotify_emergency_alert` (spec rule 29, §7.4): the same re-notify as a submit on an active
   * alert. Not called by the app (submit covers it). Spec §11.3 E4 asks for no Idempotency-Key: a
   * repeat re-notifies again, as a repeated RPC call does.
   */
  @Post(':id/renotify')
  @HttpCode(200)
  @Operation('renotify_emergency_alert')
  @ApiContract({
    operationId: 'renotifyEmergencyAlert',
    summary: "Re-notify the members of the caller's active alert",
    tag: 'incidents',
    params: incidentIdParamsSchema,
    responses: {
      200: {
        description: 'The members were re-notified',
        name: 'IncidentSend',
        schema: incidentSendSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'renotify_emergency_alert:not_found',
      'renotify_emergency_alert:not_open',
    ],
  })
  renotify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<Record<string, unknown>> {
    return this.incidents.renotify(user, requireIncidentId(id));
  }

  /**
   * `mark_incident_safe` (spec §6.7, rules 38-41): "I'm Safe Now". Closes the caller's active alert
   * once; a repeat on an incident already closed as safe is 200 with the unchanged incident and writes
   * nothing. `Idempotency-Key` is required (spec §11.2): a retry with the same key replays the first
   * response. Checks in order: token (401), key (400/422), `{id}` is uuid input (422 on field `id`),
   * then the SQL function's: not the caller's → 404 `not_found`, not `active` → 409 `not_open`.
   */
  @Post(':id/mark-safe')
  @HttpCode(200)
  @Operation('mark_incident_safe')
  @Idempotent('required')
  @RateLimit('emergency_write')
  @ApiContract({
    operationId: 'markIncidentSafe',
    summary: "Mark the caller's alert safe and close it",
    tag: 'incidents',
    params: incidentIdParamsSchema,
    responses: {
      200: {
        description:
          'The alert is closed as safe (closed by this call, or already closed as safe: unchanged)',
        name: 'IncidentSend',
        schema: incidentSendSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'mark_incident_safe:not_found',
      'mark_incident_safe:not_open',
    ],
  })
  markSafe(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<Record<string, unknown>> {
    return this.incidents.markSafe(user, requireIncidentId(id));
  }
}
