import { Module } from '@nestjs/common';

import { ActivityService } from './activity.service';
import { MeActivityController } from './me-activity.controller';

/** SCRUM-82 (D72): `GET /v1/me/activity`, the activity log built from `incident_events`. */
@Module({
  controllers: [MeActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
