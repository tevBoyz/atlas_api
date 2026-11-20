// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/avatar_upload_url.dart';
import '../models/avatar_upload_url_request.dart';
import '../models/emergency_info_request.dart';
import '../models/location_sharing_request.dart';
import '../models/personal_info_request.dart';
import '../models/preferences_request.dart';
import '../models/profile.dart';
import '../models/profile_setup_result.dart';
import '../models/set_avatar_request.dart';
import '../models/sharing_flags_request.dart';

part 'profiles_client.g.dart';

@RestApi()
abstract class ProfilesClient {
  factory ProfilesClient(Dio dio, {String? baseUrl}) = _ProfilesClient;

  /// A single-use signed URL to upload a new profile photo
  @POST('/v1/me/avatar/upload-url')
  Future<AvatarUploadUrl> createAvatarUploadUrl({
    @Body() required AvatarUploadUrlRequest body,
  });

  /// The caller's own profile and setup progress
  @GET('/v1/me/profile')
  Future<Profile> fetchOwnProfile();

  /// Use an uploaded photo as the profile photo, or remove the photo
  @PUT('/v1/me/profile/avatar')
  Future<Profile> setAvatar({@Body() required SetAvatarRequest body});

  /// Complete profile setup: create the circle, owner row and emergency-contact invite
  @POST('/v1/me/profile/complete')
  Future<ProfileSetupResult> completeProfileSetup();

  /// Save Emergency Info, its share flags and Location Sharing
  @PUT('/v1/me/profile/emergency-info')
  Future<Profile> updateEmergencyInfo({
    @Body() required EmergencyInfoRequest body,
  });

  /// Turn Location Sharing on or off
  @PATCH('/v1/me/profile/location-sharing')
  Future<Profile> updateLocationSharingEnabled({
    @Body() required LocationSharingRequest body,
  });

  /// Save Personal Info (creates the profile on first use)
  @PUT('/v1/me/profile/personal-info')
  Future<Profile> upsertPersonalInfo({
    @Body() required PersonalInfoRequest body,
  });

  /// Save Preferences (alerts, Location Sharing, languages)
  @PUT('/v1/me/profile/preferences')
  Future<Profile> updatePreferences({@Body() required PreferencesRequest body});

  /// Change any of the 9 incident share flags
  @PATCH('/v1/me/profile/sharing-flags')
  Future<Profile> updateIncidentSharingFlags({
    @Body() required SharingFlagsRequest body,
  });
}
