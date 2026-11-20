// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'blood_type.dart';
import 'relationship.dart';

part 'emergency_info_request.g.dart';

@JsonSerializable()
class EmergencyInfoRequest {
  const EmergencyInfoRequest({
    required this.emergencyContactFullName,
    required this.emergencyContactPhone,
    required this.emergencyContactRelationship,
    required this.emergencyNotesShareable,
    required this.locationSharingEnabled,
    required this.shareAllergies,
    required this.shareBloodType,
    required this.shareEmergencyContactEmail,
    required this.shareEmergencyContactFullName,
    required this.shareEmergencyContactPhone,
    required this.shareEmergencyContactRelationship,
    required this.shareEmergencyPreferredLanguage,
    required this.shareMedicalConditions,
    this.allergies,
    this.bloodType,
    this.emergencyContactEmail,
    this.emergencyNotes,
    this.emergencyPreferredLanguage,
    this.medicalConditions,
  });

  factory EmergencyInfoRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$EmergencyInfoRequestFromJson(json), json);

  /// Free text. Trimmed; blank or left out is stored as null.
  final String? allergies;

  /// Blank or left out: null (`profiles:invalid_blood_type`).
  @JsonKey(name: 'blood_type')
  final BloodType? bloodType;

  /// An email address (`profiles:invalid_email`). Trimmed; blank or left out is stored as null.
  @JsonKey(name: 'emergency_contact_email')
  final String? emergencyContactEmail;

  /// Trimmed; must not be empty (`profiles:invalid_emergency_contact_full_name`).
  @JsonKey(name: 'emergency_contact_full_name')
  final String emergencyContactFullName;

  /// Strict E.164 after trimming: `^\+[1-9][0-9]{7,14}$` (`profiles:invalid_phone`). The server adds no country code.
  @JsonKey(name: 'emergency_contact_phone')
  final String emergencyContactPhone;
  @JsonKey(name: 'emergency_contact_relationship')
  final Relationship emergencyContactRelationship;

  /// At most 500 characters (`profiles:emergency_notes_too_long`). Trimmed; blank or left out is stored as null.
  @JsonKey(name: 'emergency_notes')
  final String? emergencyNotes;
  @JsonKey(name: 'emergency_notes_shareable')
  final bool emergencyNotesShareable;

  /// Free text. Trimmed; blank or left out is stored as null.
  @JsonKey(name: 'emergency_preferred_language')
  final String? emergencyPreferredLanguage;
  @JsonKey(name: 'location_sharing_enabled')
  final bool locationSharingEnabled;

  /// Free text. Trimmed; blank or left out is stored as null.
  @JsonKey(name: 'medical_conditions')
  final String? medicalConditions;
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

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$EmergencyInfoRequestToJson(this));
}
