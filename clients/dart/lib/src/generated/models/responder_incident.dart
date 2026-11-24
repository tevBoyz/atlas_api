// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'responder_incident_emergency_type.dart';
import 'responder_incident_status.dart';

part 'responder_incident.g.dart';

@JsonSerializable()
class ResponderIncident {
  const ResponderIncident({
    required this.activatedAt,
    required this.autoClosed,
    required this.closedAt,
    required this.emergencyType,
    required this.id,
    required this.renotifiedAt,
    required this.residentName,
    required this.resolvedAt,
    required this.resolvedReason,
    required this.sentAt,
    required this.status,
  });

  factory ResponderIncident.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$ResponderIncidentFromJson(json), json);

  @JsonKey(name: 'activated_at')
  final String activatedAt;
  @JsonKey(name: 'auto_closed')
  final bool autoClosed;

  /// SCRUM-63 (D61): when the incident became Closed (final, read-only); null until then. With status closed: resolved_reason safe = closed after the wrap-up following mark safe; ended with auto_closed true = closed automatically after inactivity.
  @JsonKey(name: 'closed_at')
  final String? closedAt;
  @JsonKey(name: 'emergency_type')
  final ResponderIncidentEmergencyType emergencyType;
  final String id;
  @JsonKey(name: 'renotified_at')
  final String? renotifiedAt;

  /// The resident's full name; empty string when unknown.
  @JsonKey(name: 'resident_name')
  final String residentName;
  @JsonKey(name: 'resolved_at')
  final String? resolvedAt;
  @JsonKey(name: 'resolved_reason')
  final String? resolvedReason;
  @JsonKey(name: 'sent_at')
  final String? sentAt;
  final ResponderIncidentStatus status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$ResponderIncidentToJson(this));
}
