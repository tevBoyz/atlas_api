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

  /// Who caused the event (null when no user did). The resident of the incident gets the full UUID. Any other caller gets it obscured: the first 4 and the last 4 hex characters are kept, every other hex character is replaced by "*", and the hyphens and 36-character shape stay (e.g. "4f3a****-****-****-****-********9c2d"), unless the actor is the caller, whose own id is always shown in full. Not a usable UUID when obscured.
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
