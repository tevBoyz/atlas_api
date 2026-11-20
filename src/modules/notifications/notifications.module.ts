import { Module } from '@nestjs/common';

import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';
import { IncidentNotificationsHook, IncidentNotificationsOutbox } from './incident-notifications';
import { MeDevicesController } from './me-devices.controller';

/**
 * Notifications in the API process (Phase 5, spec §11.3 U1/U2, §11.6, §11.7): device registration
 * (API-100-44) and the incident outbox rows with their post-commit relay kick (API-100-48). The
 * worker side (fan-out, channels, deliveries) is `NotificationWorkersModule`.
 */
@Module({
  controllers: [MeDevicesController],
  providers: [
    DevicesRepository,
    DevicesService,
    IncidentNotificationsOutbox,
    IncidentNotificationsHook,
  ],
  exports: [IncidentNotificationsOutbox, IncidentNotificationsHook],
})
export class NotificationsModule {}
