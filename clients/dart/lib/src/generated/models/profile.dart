// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'blood_type.dart';
import 'gender.dart';
import 'medical_item.dart';
import 'preferred_language.dart';
import 'relationship.dart';

part 'profile.g.dart';

@JsonSerializable()
class Profile {
  const Profile({
    required this.emergencyContactPhone,
    required this.alertPushEnabled,
    required this.alertSmsEnabled,
    required this.allergies,
    required this.allergyItems,
    required this.appLanguage,
    required this.avatarPath,
    required this.avatarUrl,
    required this.bloodType,
    required this.createdAt,
    required this.dateOfBirth,
    required this.emergencyContactEmail,
    required this.emergencyContactFullName,
    required this.alertEmailEnabled,
    required this.emergencyContactRelationship,
    required this.emergencyInfoCompletedAt,
    required this.emergencyNotes,
    required this.emergencyNotesShareable,
    required this.emergencyPreferredLanguage,
    required this.fullName,
    required this.gender,
    required this.hideProfileFromNonMembers,
    required this.id,
    required this.locationSharingEnabled,
    required this.medicalConditionItems,
    required this.medicalConditions,
    required this.medicalInfoUpdatedAt,
    required this.updatedAt,
    required this.preferencesCompletedAt,
    required this.preferredLanguage,
    required this.profileSetupCompletedAt,
    required this.shareAllergies,
    required this.shareBloodType,
    required this.shareEmergencyContactEmail,
    required this.shareEmergencyContactFullName,
    required this.shareEmergencyContactPhone,
    required this.shareEmergencyContactRelationship,
    required this.shareEmergencyPreferredLanguage,
    required this.shareMedicalConditions,
    required this.sharePhone,
    required this.timezone,
    required this.personalInfoCompletedAt,
  });

  factory Profile.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$ProfileFromJson(json), json);

  @JsonKey(name: 'alert_email_enabled')
  final bool alertEmailEnabled;
  @JsonKey(name: 'alert_push_enabled')
  final bool alertPushEnabled;
  @JsonKey(name: 'alert_sms_enabled')
  final bool alertSmsEnabled;

  /// The allergy items joined with ", " (kept for old readers); use `allergy_items`.
  final String? allergies;

  /// The allergies, oldest first (SCRUM-21, D51).
  @JsonKey(name: 'allergy_items')
  final List<MedicalItem> allergyItems;
  @JsonKey(name: 'app_language')
  final String appLanguage;

  /// Object path in the `avatars` bucket, e.g. `{uid}/avatar-{uuid}.jpg`.
  @JsonKey(name: 'avatar_path')
  final String? avatarPath;

  /// Public URL of `avatar_path`: `{SUPABASE_URL}/storage/v1/object/public/avatars/{avatar_path}`; null without a photo.
  @JsonKey(name: 'avatar_url')
  final String? avatarUrl;
  @JsonKey(name: 'blood_type')
  final BloodType? bloodType;
  @JsonKey(name: 'created_at')
  final String createdAt;

  /// `YYYY-MM-DD`.
  @JsonKey(name: 'date_of_birth')
  final String dateOfBirth;
  @JsonKey(name: 'emergency_contact_email')
  final String? emergencyContactEmail;
  @JsonKey(name: 'emergency_contact_full_name')
  final String? emergencyContactFullName;
  @JsonKey(name: 'emergency_contact_phone')
  final String? emergencyContactPhone;
  @JsonKey(name: 'emergency_contact_relationship')
  final Relationship? emergencyContactRelationship;

  /// Set by the server the first time Emergency Info is saved; never reset.
  @JsonKey(name: 'emergency_info_completed_at')
  final String? emergencyInfoCompletedAt;
  @JsonKey(name: 'emergency_notes')
  final String? emergencyNotes;
  @JsonKey(name: 'emergency_notes_shareable')
  final bool emergencyNotesShareable;
  @JsonKey(name: 'emergency_preferred_language')
  final String? emergencyPreferredLanguage;
  @JsonKey(name: 'full_name')
  final String fullName;
  final Gender? gender;
  @JsonKey(name: 'hide_profile_from_non_members')
  final bool hideProfileFromNonMembers;
  final String id;
  @JsonKey(name: 'location_sharing_enabled')
  final bool locationSharingEnabled;

  /// The medical conditions, oldest first (SCRUM-21, D51).
  @JsonKey(name: 'medical_condition_items')
  final List<MedicalItem> medicalConditionItems;

  /// The medical-condition items joined with ", " (kept for old readers); use `medical_condition_items`.
  @JsonKey(name: 'medical_conditions')
  final String? medicalConditions;

  /// When the medical info last changed: an allergy or condition added, edited or deleted, or the blood type changed (SCRUM-21). Null before the first change.
  @JsonKey(name: 'medical_info_updated_at')
  final String? medicalInfoUpdatedAt;

  /// Set by the server the first time Personal Info is saved; never reset.
  @JsonKey(name: 'personal_info_completed_at')
  final String? personalInfoCompletedAt;

  /// Set by the server the first time Preferences are saved; never reset.
  @JsonKey(name: 'preferences_completed_at')
  final String? preferencesCompletedAt;
  @JsonKey(name: 'preferred_language')
  final PreferredLanguage preferredLanguage;

  /// Set by `POST /v1/me/profile/complete` (first success wins).
  @JsonKey(name: 'profile_setup_completed_at')
  final String? profileSetupCompletedAt;
  @JsonKey(name: 'share_allergies')
  final bool shareAllergies;
  @JsonKey(name: 'share_blood_type')
  final bool shareBloodType;
  @JsonKey(name: 'share_emergency_contact_email')
  final bool shareEmergencyContactEmail;
  @JsonKey(name: 'share_emergency_contact_full_name')
  final bool shareEmergencyContactFullName;
  @JsonKey(name: 'share_emergency_contact_phone')
  final bool shareEmergencyContactPhone;
  @JsonKey(name: 'share_emergency_contact_relationship')
  final bool shareEmergencyContactRelationship;
  @JsonKey(name: 'share_emergency_preferred_language')
  final bool shareEmergencyPreferredLanguage;
  @JsonKey(name: 'share_medical_conditions')
  final bool shareMedicalConditions;

  /// Share my phone number (SCRUM-52, D59): when on, members of an alert get the account's confirmed phone as `resident_phone` in the shared info. On by default.
  @JsonKey(name: 'share_phone')
  final bool sharePhone;
  final String timezone;
  @JsonKey(name: 'updated_at')
  final String updatedAt;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$ProfileToJson(this));
}
