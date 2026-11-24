// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/avatar_upload_url.dart';
import '../models/avatar_upload_url_request.dart';
import '../models/emergency_info_request.dart';
import '../models/location_sharing_request.dart';
import '../models/medical_item_request.dart';
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

  /// Add an allergy
  @POST('/v1/me/profile/allergies')
  Future<Profile> addAllergy({@Body() required MedicalItemRequest body});

  /// Delete one allergy
  @DELETE('/v1/me/profile/allergies/{item_id}')
  Future<Profile> deleteAllergy({@Path('item_id') required String itemId});

  /// Change the text of one allergy
  @PATCH('/v1/me/profile/allergies/{item_id}')
  Future<Profile> editAllergy({
    @Path('item_id') required String itemId,
    @Body() required MedicalItemRequest body,
  });

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

  /// Add a medical condition
  @POST('/v1/me/profile/medical-conditions')
  Future<Profile> addMedicalCondition({
    @Body() required MedicalItemRequest body,
  });

  /// Delete one medical condition
  @DELETE('/v1/me/profile/medical-conditions/{item_id}')
  Future<Profile> deleteMedicalCondition({
    @Path('item_id') required String itemId,
  });

  /// Change the text of one medical condition
  @PATCH('/v1/me/profile/medical-conditions/{item_id}')
  Future<Profile> editMedicalCondition({
    @Path('item_id') required String itemId,
    @Body() required MedicalItemRequest body,
  });

  /// Save Personal Info (creates the profile on first use)
  @PUT('/v1/me/profile/personal-info')
  Future<Profile> upsertPersonalInfo({
    @Body() required PersonalInfoRequest body,
  });

  /// Save Preferences (alerts, Location Sharing, languages)
  @PUT('/v1/me/profile/preferences')
  Future<Profile> updatePreferences({@Body() required PreferencesRequest body});

  /// Change any of the incident share flags (the 9 flags and share_phone)
  @PATCH('/v1/me/profile/sharing-flags')
  Future<Profile> updateIncidentSharingFlags({
    @Body() required SharingFlagsRequest body,
  });
}
