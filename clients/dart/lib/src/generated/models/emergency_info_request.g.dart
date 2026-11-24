// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'emergency_info_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EmergencyInfoRequest _$EmergencyInfoRequestFromJson(
  Map<String, dynamic> json,
) => EmergencyInfoRequest(
  emergencyContactFullName: json['emergency_contact_full_name'] as String,
  emergencyContactPhone: json['emergency_contact_phone'] as String,
  emergencyContactRelationship: Relationship.fromJson(
    json['emergency_contact_relationship'] as String,
  ),
  emergencyNotesShareable: json['emergency_notes_shareable'] as bool,
  locationSharingEnabled: json['location_sharing_enabled'] as bool,
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
  allergies: json['allergies'] as String?,
  bloodType: json['blood_type'] == null
      ? null
      : BloodType.fromJson(json['blood_type'] as String),
  emergencyContactEmail: json['emergency_contact_email'] as String?,
  emergencyNotes: json['emergency_notes'] as String?,
  emergencyPreferredLanguage: json['emergency_preferred_language'] as String?,
  medicalConditions: json['medical_conditions'] as String?,
  sharePhone: json['share_phone'] as bool?,
);

Map<String, dynamic> _$EmergencyInfoRequestToJson(
  EmergencyInfoRequest instance,
) => <String, dynamic>{
  'allergies': instance.allergies,
  'blood_type': instance.bloodType,
  'emergency_contact_email': instance.emergencyContactEmail,
  'emergency_contact_full_name': instance.emergencyContactFullName,
  'emergency_contact_phone': instance.emergencyContactPhone,
  'emergency_contact_relationship': instance.emergencyContactRelationship,
  'emergency_notes': instance.emergencyNotes,
  'emergency_notes_shareable': instance.emergencyNotesShareable,
  'emergency_preferred_language': instance.emergencyPreferredLanguage,
  'location_sharing_enabled': instance.locationSharingEnabled,
  'medical_conditions': instance.medicalConditions,
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
};
