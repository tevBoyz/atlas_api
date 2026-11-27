// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'submit_emergency_alert_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SubmitEmergencyAlertRequest _$SubmitEmergencyAlertRequestFromJson(
  Map<String, dynamic> json,
) => SubmitEmergencyAlertRequest(
  emergencyType: SubmitEmergencyAlertRequestEmergencyType.fromJson(
    json['emergency_type'] as String,
  ),
  countryCode: json['country_code'] as String?,
  placeName: json['place_name'] as String?,
);

Map<String, dynamic> _$SubmitEmergencyAlertRequestToJson(
  SubmitEmergencyAlertRequest instance,
) => <String, dynamic>{
  'country_code': instance.countryCode,
  'emergency_type': instance.emergencyType,
  'place_name': instance.placeName,
};
