// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'sharing_flags_request.g.dart';

@JsonSerializable()
class SharingFlagsRequest {
  const SharingFlagsRequest({
    this.emergencyNotesShareable,
    this.shareAllergies,
    this.shareBloodType,
    this.shareEmergencyContactEmail,
    this.shareEmergencyContactFullName,
    this.shareEmergencyContactPhone,
    this.shareEmergencyContactRelationship,
    this.shareEmergencyPreferredLanguage,
    this.shareMedicalConditions,
    this.sharePhone,
  });

  factory SharingFlagsRequest.fromJson(Map<String, Object?> json) =>
      _$SharingFlagsRequestFromJson(json);

  @JsonKey(name: 'emergency_notes_shareable')
  final bool? emergencyNotesShareable;
  @JsonKey(name: 'share_allergies')
  final bool? shareAllergies;
  @JsonKey(name: 'share_blood_type')
  final bool? shareBloodType;
  @JsonKey(name: 'share_emergency_contact_email')
  final bool? shareEmergencyContactEmail;
  @JsonKey(name: 'share_emergency_contact_full_name')
  final bool? shareEmergencyContactFullName;
  @JsonKey(name: 'share_emergency_contact_phone')
  final bool? shareEmergencyContactPhone;
  @JsonKey(name: 'share_emergency_contact_relationship')
  final bool? shareEmergencyContactRelationship;
  @JsonKey(name: 'share_emergency_preferred_language')
  final bool? shareEmergencyPreferredLanguage;
  @JsonKey(name: 'share_medical_conditions')
  final bool? shareMedicalConditions;
  @JsonKey(name: 'share_phone')
  final bool? sharePhone;

  Map<String, Object?> toJson() => _$SharingFlagsRequestToJson(this);
}
