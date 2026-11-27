// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'incident_event.g.dart';

@JsonSerializable()
class IncidentEvent {
  const IncidentEvent({
    required this.actorHandle,
    required this.actorId,
    required this.actorName,
    required this.detail,
    required this.eventType,
    required this.id,
    required this.occurredAt,
  });

  factory IncidentEvent.fromJson(Map<String, Object?> json) =>
      _$IncidentEventFromJson(json);

  /// D79: the actor member's handle (their membership row id, the Responder handle) when a member caused the event; null when the resident or no user did.
  @JsonKey(name: 'actor_handle')
  final String? actorHandle;

  /// D79: the caller's own user id when the caller caused the event, else null (also when another user or no user caused it). No other user id is ever sent: use actor_handle / actor_name.
  @JsonKey(name: 'actor_id')
  final String? actorId;

  /// D71: the display name of the actor, the same for every caller (show it instead of any id); null when actor_id is null. A member: their profile name (trimmed), else the name on their membership, as the responder list. The resident: their profile name (trimmed). Empty when no name is known.
  @JsonKey(name: 'actor_name')
  final String? actorName;
  final Map<String, dynamic> detail;

  /// See spec §5.6: alert_sent, renotified, location_sharing_started, location_sharing_ended, safe_recorded, incident_closed, closure_notified, status_update (D70: detail {preset} or {text}), responder_acknowledged (D71: a member acknowledged, detail {}) and responder_status (D71: a member changed their response, detail {status: "responding" | "unable"}).
  @JsonKey(name: 'event_type')
  final String eventType;
  final String id;
  @JsonKey(name: 'occurred_at')
  final String occurredAt;

  Map<String, Object?> toJson() => _$IncidentEventToJson(this);
}
