// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'submit_emergency_alert_request_emergency_type.dart';

part 'submit_emergency_alert_request.g.dart';

@JsonSerializable()
class SubmitEmergencyAlertRequest {
  const SubmitEmergencyAlertRequest({
    required this.emergencyType,
    this.countryCode,
    this.placeName,
  });

  factory SubmitEmergencyAlertRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$SubmitEmergencyAlertRequestFromJson(json), json);

  /// Stage 2 [B9]: ISO 3166-1 alpha-2 country of that place (e.g. `GM`; stored uppercase). Chooses the incident's `emergency_services`. Left out keeps the stored country; a value that is not two letters is ignored.
  @JsonKey(name: 'country_code')
  final String? countryCode;
  @JsonKey(name: 'emergency_type')
  final SubmitEmergencyAlertRequestEmergencyType emergencyType;

  /// Stage 2 [B6]: the place reverse-geocoded on the phone from the current or last known fix (e.g. `Serrekunda`); trimmed, 1-120 characters. The alert push says "near <place_name>". Left out keeps the stored place; a value that is not valid is ignored (never an error).
  @JsonKey(name: 'place_name')
  final String? placeName;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$SubmitEmergencyAlertRequestToJson(this));
}
