import { Module } from '@nestjs/common';

import { IncidentsModule } from '../incidents/incidents.module';
import { LocationsController } from './locations.controller';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';

/** Live location of an active incident (API-100-17): `POST /v1/incidents/{id}/locations`. */
@Module({
  imports: [IncidentsModule],
  controllers: [LocationsController],
  providers: [LocationsRepository, LocationsService],
})
export class LocationsModule {}
