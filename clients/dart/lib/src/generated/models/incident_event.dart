// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'incident_event.g.dart';

@JsonSerializable()
class IncidentEvent {
  const IncidentEvent({
    required this.actorId,
    required this.detail,
    required this.eventType,
    required this.id,
    required this.occurredAt,
  });

  factory IncidentEvent.fromJson(Map<String, Object?> json) =>
      _$IncidentEventFromJson(json);

  @JsonKey(name: 'actor_id')
  final String? actorId;
  final Map<String, dynamic> detail;

  /// See spec §5.6 (alert_sent, renotified, closure_notified, ...).
  @JsonKey(name: 'event_type')
  final String eventType;
  final String id;
  @JsonKey(name: 'occurred_at')
  final String occurredAt;

  Map<String, Object?> toJson() => _$IncidentEventToJson(this);
}
