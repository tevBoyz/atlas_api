// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'activity_incident_emergency_type.dart';
import 'activity_incident_status.dart';

part 'activity_incident.g.dart';

@JsonSerializable()
class ActivityIncident {
  const ActivityIncident({
    required this.circleName,
    required this.emergencyType,
    required this.id,
    required this.residentName,
    required this.status,
  });

  factory ActivityIncident.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$ActivityIncidentFromJson(json), json);

  /// Circle entries: the Safety Circle's name. Null on the caller's own alerts.
  @JsonKey(name: 'circle_name')
  final String? circleName;
  @JsonKey(name: 'emergency_type')
  final ActivityIncidentEmergencyType emergencyType;

  /// The alert (open it with the existing incident reads).
  final String id;

  /// Circle entries: the resident's profile name, trimmed ('' when unknown). Null on the caller's own alerts.
  @JsonKey(name: 'resident_name')
  final String? residentName;

  /// The alert's CURRENT state (active, resolved, closed), not the state at the entry's time.
  final ActivityIncidentStatus status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$ActivityIncidentToJson(this));
}
