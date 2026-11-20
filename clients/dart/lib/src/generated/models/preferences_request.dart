// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'preferred_language.dart';

part 'preferences_request.g.dart';

@JsonSerializable()
class PreferencesRequest {
  const PreferencesRequest({
    required this.alertEmailEnabled,
    required this.alertPushEnabled,
    required this.alertSmsEnabled,
    required this.appLanguage,
    required this.hideProfileFromNonMembers,
    required this.locationSharingEnabled,
    required this.preferredLanguage,
    required this.timezone,
  });

  factory PreferencesRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$PreferencesRequestFromJson(json), json);

  @JsonKey(name: 'alert_email_enabled')
  final bool alertEmailEnabled;
  @JsonKey(name: 'alert_push_enabled')
  final bool alertPushEnabled;
  @JsonKey(name: 'alert_sms_enabled')
  final bool alertSmsEnabled;

  /// `profiles:invalid_app_language`.
  @JsonKey(name: 'app_language')
  final String appLanguage;
  @JsonKey(name: 'hide_profile_from_non_members')
  final bool hideProfileFromNonMembers;
  @JsonKey(name: 'location_sharing_enabled')
  final bool locationSharingEnabled;
  @JsonKey(name: 'preferred_language')
  final PreferredLanguage preferredLanguage;

  /// `profiles:invalid_timezone`.
  final String timezone;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$PreferencesRequestToJson(this));
}
