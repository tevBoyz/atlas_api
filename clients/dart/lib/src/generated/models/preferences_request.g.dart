// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'preferences_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PreferencesRequest _$PreferencesRequestFromJson(Map<String, dynamic> json) =>
    PreferencesRequest(
      alertEmailEnabled: json['alert_email_enabled'] as bool,
      alertPushEnabled: json['alert_push_enabled'] as bool,
      alertSmsEnabled: json['alert_sms_enabled'] as bool,
      appLanguage: json['app_language'] as String,
      hideProfileFromNonMembers: json['hide_profile_from_non_members'] as bool,
      locationSharingEnabled: json['location_sharing_enabled'] as bool,
      preferredLanguage: PreferredLanguage.fromJson(
        json['preferred_language'] as String,
      ),
      timezone: json['timezone'] as String,
    );

Map<String, dynamic> _$PreferencesRequestToJson(PreferencesRequest instance) =>
    <String, dynamic>{
      'alert_email_enabled': instance.alertEmailEnabled,
      'alert_push_enabled': instance.alertPushEnabled,
      'alert_sms_enabled': instance.alertSmsEnabled,
      'app_language': instance.appLanguage,
      'hide_profile_from_non_members': instance.hideProfileFromNonMembers,
      'location_sharing_enabled': instance.locationSharingEnabled,
      'preferred_language': instance.preferredLanguage,
      'timezone': instance.timezone,
    };
