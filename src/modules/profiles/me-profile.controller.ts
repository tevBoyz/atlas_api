import { Body, Controller, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { type ErrorCode, Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import {
  emergencyInfoRequestSchema,
  locationSharingRequestSchema,
  personalInfoRequestSchema,
  preferencesRequestSchema,
  profileSchema,
  profileSetupResultSchema,
  setAvatarRequestSchema,
  sharingFlagsRequestSchema,
} from './profile.schemas';
import type { ProfileSetupJson } from './profile-setup.repository';
import { ProfileSetupService } from './profile-setup.service';
import { AvatarsService } from './avatars.service';
import type { ProfileJson } from './profiles.repository';
import { ProfilesService } from './profiles.service';

const PROFILE_RESPONSE = {
  description: 'The full Profile after the write (as `GET /v1/me/profile`).',
  name: 'Profile',
  schema: profileSchema,
};

const NO_TIMESTAMPS =
  'Completion timestamps are set by the server the first time and never reset; a request cannot write them.';

/** The field codes of P3, in the body's field order. */
const EMERGENCY_INFO_ERRORS: readonly ErrorCode[] = [
  'profiles:invalid_emergency_contact_full_name',
  'profiles:invalid_relationship',
  'profiles:invalid_phone',
  'profiles:invalid_email',
  'profiles:invalid_blood_type',
  'profiles:emergency_notes_too_long',
];

/**
 * The caller's own profile (spec §11.3 P1-P7, API-100-34/35/36). Default authenticated rate limit.
 * There is no route with a profile id: every route works on the token's user only (`profile.self`).
 * No Idempotency-Key: every write is a plain overwrite of the caller's own values (repeating it
 * changes nothing).
 */
@Controller('me/profile')
export class MeProfileController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly setup: ProfileSetupService,
    private readonly avatars: AvatarsService,
  ) {}

  /** P1. Replaces the app's `profiles` SELECT (`fetchOwn`, `is*Complete`). */
  @Get()
  @Operation('profiles')
  @ApiContract({
    operationId: 'fetchOwnProfile',
    summary: "The caller's own profile and setup progress",
    tag: 'profiles',
    responses: {
      200: {
        description:
          'Every `profiles` column plus `avatar_url`. Setup progress = which `*_completed_at` are set.',
        name: 'Profile',
        schema: profileSchema,
      },
    },
    errors: ['profiles:profile_not_found'],
  })
  ownProfile(@CurrentUser() user: AuthenticatedUser): Promise<ProfileJson> {
    return this.profiles.ownProfile(user);
  }

  /** P2. Replaces the app's `profiles` UPSERT (`upsertPersonalInfo`). */
  @Put('personal-info')
  @Operation('profiles')
  @ApiContract({
    operationId: 'upsertPersonalInfo',
    summary: 'Save Personal Info (creates the profile on first use)',
    tag: 'profiles',
    body: { name: 'PersonalInfoRequest', schema: personalInfoRequestSchema },
    responses: {
      200: {
        ...PROFILE_RESPONSE,
        description: `${PROFILE_RESPONSE.description} \`personal_info_completed_at\` is set on the first save. ${NO_TIMESTAMPS}`,
      },
    },
    errors: [
      'validation:invalid_request',
      'profiles:invalid_full_name',
      'profiles:invalid_date_of_birth',
      'profiles:invalid_gender',
      'profiles:invalid_avatar_path',
    ],
  })
  upsertPersonalInfo(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.upsertPersonalInfo(user, body);
  }

  /** P3. Replaces the app's `profiles` UPDATE (`updateEmergencyInfo`). */
  @Put('emergency-info')
  @Operation('profiles')
  @ApiContract({
    operationId: 'updateEmergencyInfo',
    summary: 'Save Emergency Info, its share flags and Location Sharing',
    tag: 'profiles',
    body: { name: 'EmergencyInfoRequest', schema: emergencyInfoRequestSchema },
    responses: {
      200: {
        ...PROFILE_RESPONSE,
        description: `${PROFILE_RESPONSE.description} \`emergency_info_completed_at\` is set on the first save. ${NO_TIMESTAMPS}`,
      },
    },
    errors: ['validation:invalid_request', ...EMERGENCY_INFO_ERRORS, 'profiles:profile_not_found'],
  })
  updateEmergencyInfo(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.updateEmergencyInfo(user, body);
  }

  /** P4. Replaces the app's `profiles` UPDATE (`updatePreferences`). */
  @Put('preferences')
  @Operation('profiles')
  @ApiContract({
    operationId: 'updatePreferences',
    summary: 'Save Preferences (alerts, Location Sharing, languages)',
    tag: 'profiles',
    body: { name: 'PreferencesRequest', schema: preferencesRequestSchema },
    responses: {
      200: {
        ...PROFILE_RESPONSE,
        description: `${PROFILE_RESPONSE.description} \`preferences_completed_at\` is set on the first save. Turning Location Sharing on does not create the circle: call \`POST /v1/me/profile/complete\`. ${NO_TIMESTAMPS}`,
      },
    },
    errors: [
      'validation:invalid_request',
      'profiles:invalid_app_language',
      'profiles:invalid_timezone',
      'profiles:invalid_preferred_language',
      'profiles:profile_not_found',
    ],
  })
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.updatePreferences(user, body);
  }

  /** P5. Replaces the app's `profiles` UPDATE of the 9 flags (`updateIncidentSharingFlags`). */
  @Patch('sharing-flags')
  @Operation('profiles')
  @ApiContract({
    operationId: 'updateIncidentSharingFlags',
    summary: 'Change any of the 9 incident share flags',
    tag: 'profiles',
    body: { name: 'SharingFlagsRequest', schema: sharingFlagsRequestSchema },
    responses: {
      200: {
        ...PROFILE_RESPONSE,
        description: `${PROFILE_RESPONSE.description} Only the flags sent change; nothing else is written.`,
      },
    },
    errors: ['validation:invalid_request', 'profiles:profile_not_found'],
  })
  updateIncidentSharingFlags(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.updateSharingFlags(user, body);
  }

  /** P6. Replaces the app's `profiles` UPDATE of `location_sharing_enabled`. */
  @Patch('location-sharing')
  @Operation('profiles')
  @ApiContract({
    operationId: 'updateLocationSharingEnabled',
    summary: 'Turn Location Sharing on or off',
    tag: 'profiles',
    body: { name: 'LocationSharingRequest', schema: locationSharingRequestSchema },
    responses: {
      200: {
        ...PROFILE_RESPONSE,
        description: `${PROFILE_RESPONSE.description} Turning it on does not create the circle: then call \`POST /v1/me/profile/complete\` (spec rule 6a).`,
      },
    },
    errors: ['validation:invalid_request', 'profiles:profile_not_found'],
  })
  updateLocationSharingEnabled(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.updateLocationSharing(user, body);
  }

  /**
   * P7, `complete_profile_setup()`. Also the deferred circle creation (spec rules 5, 6a): turn
   * Location Sharing on (P6), then call this again.
   */
  @Post('complete')
  @HttpCode(200)
  @Operation('complete_profile_setup')
  @ApiContract({
    operationId: 'completeProfileSetup',
    summary: 'Complete profile setup: create the circle, owner row and emergency-contact invite',
    tag: 'profiles',
    responses: {
      200: {
        description:
          'Idempotent (`profile_setup_completed_at` keeps its first value). With Location Sharing off: no circle (`circle_id`, `member_id`, `member_status` null); call again after turning it on. With it on: the circle `My Safety Circle`, the owner row and a pending 7-day invite for the emergency contact; a contact row that would need a slot at 5/5 is left as it is (its stored status is returned).',
        name: 'ProfileSetupResult',
        schema: profileSetupResultSchema,
      },
    },
    errors: [
      'complete_profile_setup:profile_not_found',
      'complete_profile_setup:personal_info_incomplete',
      'complete_profile_setup:emergency_info_incomplete',
      'complete_profile_setup:preferences_incomplete',
    ],
  })
  completeProfileSetup(@CurrentUser() user: AuthenticatedUser): Promise<ProfileSetupJson> {
    return this.setup.complete(user);
  }

  /** P9. Points the profile at an uploaded photo (or removes it); deletes the previous object. */
  @Put('avatar')
  @Operation('profiles')
  @ApiContract({
    operationId: 'setAvatar',
    summary: 'Use an uploaded photo as the profile photo, or remove the photo',
    tag: 'profiles',
    body: { name: 'SetAvatarRequest', schema: setAvatarRequestSchema },
    responses: {
      200: {
        ...PROFILE_RESPONSE,
        description: `${PROFILE_RESPONSE.description} The previous photo object of the caller's folder is deleted afterwards (best effort).`,
      },
    },
    errors: [
      'validation:invalid_request',
      'profiles:invalid_avatar_path',
      'profiles:profile_not_found',
      'profiles:avatar_not_found',
      'profiles:avatar_storage_unavailable',
    ],
  })
  setAvatar(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<ProfileJson> {
    return this.avatars.setAvatar(user, body);
  }
}
