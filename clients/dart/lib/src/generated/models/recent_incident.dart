// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'recent_incident_emergency_type.dart';
import 'recent_incident_status.dart';

part 'recent_incident.g.dart';

@JsonSerializable()
class RecentIncident {
  const RecentIncident({
    required this.activatedAt,
    required this.emergencyType,
    required this.id,
    required this.resolvedAt,
    required this.resolvedReason,
    required this.sentAt,
    required this.status,
  });

  factory RecentIncident.fromJson(Map<String, Object?> json) =>
      _$RecentIncidentFromJson(json);

  @JsonKey(name: 'activated_at')
  final String activatedAt;
  @JsonKey(name: 'emergency_type')
  final RecentIncidentEmergencyType emergencyType;
  final String id;
  @JsonKey(name: 'resolved_at')
  final String? resolvedAt;
  @JsonKey(name: 'resolved_reason')
  final String? resolvedReason;
  @JsonKey(name: 'sent_at')
  final String? sentAt;
  final RecentIncidentStatus status;

  Map<String, Object?> toJson() => _$RecentIncidentToJson(this);
}
