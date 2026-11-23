import { Module } from '@nestjs/common';

import { ApiConfigService } from '../../config';
import { AuditModule } from '../audit/audit.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { AVATAR_STORAGE, type AvatarStorage } from './avatar-storage';
import { AvatarsService } from './avatars.service';
import { FakeStorageRoute } from './fake-storage.route';
import { MeAvatarController } from './me-avatar.controller';
import { MeMedicalItemsController } from './me-medical-items.controller';
import { MeProfileController } from './me-profile.controller';
import { MemoryAvatarStorage } from './memory-avatar-storage';
import { ProfileSetupRepository } from './profile-setup.repository';
import { ProfileSetupService } from './profile-setup.service';
import { MedicalItemsRepository, ProfilesRepository } from './profiles.repository';
import { ProfilesService } from './profiles.service';
import { SupabaseAvatarStorage } from './supabase-avatar-storage';

/** The avatar storage of `AVATAR_STORAGE` (API-100-37): Supabase, or the in-memory fake. */
export function avatarStorageFor(config: ApiConfigService): AvatarStorage {
  const bucket = config.get('AVATARS_BUCKET');
  if (config.get('AVATAR_STORAGE') === 'memory') {
    return new MemoryAvatarStorage(`http://127.0.0.1:${config.get('PORT')}`, bucket);
  }
  return new SupabaseAvatarStorage({
    projectUrl: config.get('SUPABASE_URL'),
    serviceKey: config.get('SUPABASE_STORAGE_SERVICE_KEY'),
    bucket,
  });
}

/**
 * Profiles (spec §11.3 profiles module): the caller's own profile (API-100-34), its writes
 * (API-100-35), profile setup with the deferred circle creation (API-100-36) and profile photos
 * through signed Storage URLs (API-100-37), and the medical item lists (SCRUM-21, D51) with the live
 * incident view (D53, through the incidents module's repository and post-commit hooks).
 */
@Module({
  imports: [AuditModule, IncidentsModule],
  controllers: [MeProfileController, MeAvatarController, MeMedicalItemsController],
  providers: [
    ProfilesRepository,
    MedicalItemsRepository,
    ProfilesService,
    ProfileSetupRepository,
    ProfileSetupService,
    AvatarsService,
    { provide: AVATAR_STORAGE, inject: [ApiConfigService], useFactory: avatarStorageFor },
    FakeStorageRoute,
  ],
})
export class ProfilesModule {}
