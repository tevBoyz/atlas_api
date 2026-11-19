// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'responder_incident_emergency_type.dart';
import 'responder_incident_status.dart';

part 'responder_incident.g.dart';

@JsonSerializable()
class ResponderIncident {
  const ResponderIncident({
    required this.activatedAt,
    required this.autoClosed,
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
      _$ResponderIncidentFromJson(json);

  @JsonKey(name: 'activated_at')
  final String activatedAt;
  @JsonKey(name: 'auto_closed')
  final bool autoClosed;
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

  Map<String, Object?> toJson() => _$ResponderIncidentToJson(this);
}
