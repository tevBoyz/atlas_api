import { ActivityModule } from './activity/activity.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CirclesModule } from './circles/circles.module';
import { ConfigModule } from './config/config.module';
import { IncidentsModule } from './incidents/incidents.module';
import { InvitesModule } from './invites/invites.module';
import { LocationsModule } from './locations/locations.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ProfilesModule } from './profiles/profiles.module';
import { UsersModule } from './users/users.module';

/** Every feature module of the modular monolith (spec §11.1). Registered in AppModule. */
export const FEATURE_MODULES = [
  AuthModule,
  UsersModule,
  ProfilesModule,
  CirclesModule,
  InvitesModule,
  IncidentsModule,
  LocationsModule,
  NotificationsModule,
  ActivityModule,
  ConfigModule,
  AuditModule,
];
