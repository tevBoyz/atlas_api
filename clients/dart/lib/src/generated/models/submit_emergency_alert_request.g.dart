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
);

Map<String, dynamic> _$SubmitEmergencyAlertRequestToJson(
  SubmitEmergencyAlertRequest instance,
) => <String, dynamic>{'emergency_type': instance.emergencyType};
