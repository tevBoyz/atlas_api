// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'submit_emergency_alert_request_emergency_type.dart';

part 'submit_emergency_alert_request.g.dart';

@JsonSerializable()
class SubmitEmergencyAlertRequest {
  const SubmitEmergencyAlertRequest({required this.emergencyType});

  factory SubmitEmergencyAlertRequest.fromJson(Map<String, Object?> json) =>
      _$SubmitEmergencyAlertRequestFromJson(json);

  @JsonKey(name: 'emergency_type')
  final SubmitEmergencyAlertRequestEmergencyType emergencyType;

  Map<String, Object?> toJson() => _$SubmitEmergencyAlertRequestToJson(this);
}
