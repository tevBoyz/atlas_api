import { Controller, Get } from '@nestjs/common';

import { Operation } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { readEmergencyServices } from './emergency-numbers';
import {
  type EmergencyNumbers,
  emergencyNumbersSchema,
  INCIDENT_REGION,
} from './emergency-numbers.schemas';

/** SCRUM-54 (D60): the local emergency numbers, from `app_config` (spec §11.3 config module). */
@Controller('config')
export class EmergencyNumbersController {
  constructor(private readonly database: DatabaseService) {}

  /** Any valid token, no profile needed (as `GET /v1/config/live-location`). Nothing is written. */
  @Get('emergency-numbers')
  @Operation('get_emergency_numbers')
  @ApiContract({
    operationId: 'getEmergencyNumbers',
    summary: 'The local emergency numbers (ambulance, police, fire and rescue)',
    tag: 'config',
    responses: {
      200: {
        description:
          'The numbers of the V1 region (The Gambia, `GM`) from app_config `emergency_numbers`, in the fixed order ambulance, police, fire_rescue. The same list is on the incident reads as `emergency_services`.',
        name: 'EmergencyNumbers',
        schema: emergencyNumbersSchema,
      },
    },
  })
  async emergencyNumbers(): Promise<EmergencyNumbers> {
    return {
      country: INCIDENT_REGION,
      emergency_services: await readEmergencyServices(this.database.db, INCIDENT_REGION),
    };
  }
}
