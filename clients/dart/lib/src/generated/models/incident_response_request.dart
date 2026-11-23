// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'incident_response_request_status.dart';

part 'incident_response_request.g.dart';

@JsonSerializable()
class IncidentResponseRequest {
  const IncidentResponseRequest({required this.status});

  factory IncidentResponseRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$IncidentResponseRequestFromJson(json), json);

  /// "responding" (I am responding) or "unable" (unable to respond). Anything else is 422 incident_response:invalid_status.
  final IncidentResponseRequestStatus status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$IncidentResponseRequestToJson(this));
}
