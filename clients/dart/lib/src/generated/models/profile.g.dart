// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'profile.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Profile _$ProfileFromJson(Map<String, dynamic> json) => Profile(
  emergencyContactPhone: json['emergency_contact_phone'] as String?,
  alertPushEnabled: json['alert_push_enabled'] as bool,
  alertSmsEnabled: json['alert_sms_enabled'] as bool,
  allergies: json['allergies'] as String?,
  allergyItems: (json['allergy_items'] as List<dynamic>)
      .map((e) => MedicalItem.fromJson(e as Map<String, dynamic>))
      .toList(),
  appLanguage: json['app_language'] as String,
  avatarPath: json['avatar_path'] as String?,
  avatarUrl: json['avatar_url'] as String?,
  bloodType: json['blood_type'] == null
      ? null
      : BloodType.fromJson(json['blood_type'] as String),
  createdAt: json['created_at'] as String,
  dateOfBirth: json['date_of_birth'] as String?,
  emergencyContactEmail: json['emergency_contact_email'] as String?,
  emergencyContactFullName: json['emergency_contact_full_name'] as String?,
  alertEmailEnabled: json['alert_email_enabled'] as bool,
  emergencyContactRelationship: json['emergency_contact_relationship'] == null
      ? null
      : Relationship.fromJson(json['emergency_contact_relationship'] as String),
  emergencyInfoCompletedAt: json['emergency_info_completed_at'] as String?,
  emergencyNotes: json['emergency_notes'] as String?,
  emergencyNotesShareable: json['emergency_notes_shareable'] as bool,
  emergencyPreferredLanguage: json['emergency_preferred_language'] as String?,
  fullName: json['full_name'] as String,
  gender: json['gender'] == null
      ? null
      : Gender.fromJson(json['gender'] as String),
  hideProfileFromNonMembers: json['hide_profile_from_non_members'] as bool,
  id: json['id'] as String,
  locationSharingEnabled: json['location_sharing_enabled'] as bool,
  medicalConditionItems: (json['medical_condition_items'] as List<dynamic>)
      .map((e) => MedicalItem.fromJson(e as Map<String, dynamic>))
      .toList(),
  medicalConditions: json['medical_conditions'] as String?,
  medicalInfoUpdatedAt: json['medical_info_updated_at'] as String?,
  updatedAt: json['updated_at'] as String,
  preferencesCompletedAt: json['preferences_completed_at'] as String?,
  preferredLanguage: PreferredLanguage.fromJson(
    json['preferred_language'] as String,
  ),
  profileSetupCompletedAt: json['profile_setup_completed_at'] as String?,
  shareAllergies: json['share_allergies'] as bool,
  shareBloodType: json['share_blood_type'] as bool,
  shareEmergencyContactEmail: json['share_emergency_contact_email'] as bool,
  shareEmergencyContactFullName:
      json['share_emergency_contact_full_name'] as bool,
  shareEmergencyContactPhone: json['share_emergency_contact_phone'] as bool,
  shareEmergencyContactRelationship:
      json['share_emergency_contact_relationship'] as bool,
  shareEmergencyPreferredLanguage:
      json['share_emergency_preferred_language'] as bool,
  shareMedicalConditions: json['share_medical_conditions'] as bool,
  sharePhone: json['share_phone'] as bool,
  timezone: json['timezone'] as String,
  personalInfoCompletedAt: json['personal_info_completed_at'] as String?,
);

Map<String, dynamic> _$ProfileToJson(Profile instance) => <String, dynamic>{
  'alert_email_enabled': instance.alertEmailEnabled,
  'alert_push_enabled': instance.alertPushEnabled,
  'alert_sms_enabled': instance.alertSmsEnabled,
  'allergies': instance.allergies,
  'allergy_items': instance.allergyItems,
  'app_language': instance.appLanguage,
  'avatar_path': instance.avatarPath,
  'avatar_url': instance.avatarUrl,
  'blood_type': instance.bloodType,
  'created_at': instance.createdAt,
  'date_of_birth': instance.dateOfBirth,
  'emergency_contact_email': instance.emergencyContactEmail,
  'emergency_contact_full_name': instance.emergencyContactFullName,
  'emergency_contact_phone': instance.emergencyContactPhone,
  'emergency_contact_relationship': instance.emergencyContactRelationship,
  'emergency_info_completed_at': instance.emergencyInfoCompletedAt,
  'emergency_notes': instance.emergencyNotes,
  'emergency_notes_shareable': instance.emergencyNotesShareable,
  'emergency_preferred_language': instance.emergencyPreferredLanguage,
  'full_name': instance.fullName,
  'gender': instance.gender,
  'hide_profile_from_non_members': instance.hideProfileFromNonMembers,
  'id': instance.id,
  'location_sharing_enabled': instance.locationSharingEnabled,
  'medical_condition_items': instance.medicalConditionItems,
  'medical_conditions': instance.medicalConditions,
  'medical_info_updated_at': instance.medicalInfoUpdatedAt,
  'personal_info_completed_at': instance.personalInfoCompletedAt,
  'preferences_completed_at': instance.preferencesCompletedAt,
  'preferred_language': instance.preferredLanguage,
  'profile_setup_completed_at': instance.profileSetupCompletedAt,
  'share_allergies': instance.shareAllergies,
  'share_blood_type': instance.shareBloodType,
  'share_emergency_contact_email': instance.shareEmergencyContactEmail,
  'share_emergency_contact_full_name': instance.shareEmergencyContactFullName,
  'share_emergency_contact_phone': instance.shareEmergencyContactPhone,
  'share_emergency_contact_relationship':
      instance.shareEmergencyContactRelationship,
  'share_emergency_preferred_language':
      instance.shareEmergencyPreferredLanguage,
  'share_medical_conditions': instance.shareMedicalConditions,
  'share_phone': instance.sharePhone,
  'timezone': instance.timezone,
  'updated_at': instance.updatedAt,
};
