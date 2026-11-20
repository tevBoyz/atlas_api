// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'sharing_flags_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SharingFlagsRequest _$SharingFlagsRequestFromJson(
  Map<String, dynamic> json,
) => SharingFlagsRequest(
  emergencyNotesShareable: json['emergency_notes_shareable'] as bool?,
  shareAllergies: json['share_allergies'] as bool?,
  shareBloodType: json['share_blood_type'] as bool?,
  shareEmergencyContactEmail: json['share_emergency_contact_email'] as bool?,
  shareEmergencyContactFullName:
      json['share_emergency_contact_full_name'] as bool?,
  shareEmergencyContactPhone: json['share_emergency_contact_phone'] as bool?,
  shareEmergencyContactRelationship:
      json['share_emergency_contact_relationship'] as bool?,
  shareEmergencyPreferredLanguage:
      json['share_emergency_preferred_language'] as bool?,
  shareMedicalConditions: json['share_medical_conditions'] as bool?,
);

Map<String, dynamic> _$SharingFlagsRequestToJson(
  SharingFlagsRequest instance,
) => <String, dynamic>{
  'emergency_notes_shareable': instance.emergencyNotesShareable,
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
};
