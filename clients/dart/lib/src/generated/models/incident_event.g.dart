// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'incident_event.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

IncidentEvent _$IncidentEventFromJson(Map<String, dynamic> json) =>
    IncidentEvent(
      actorId: json['actor_id'] as String?,
      actorName: json['actor_name'] as String?,
      detail: json['detail'] as Map<String, dynamic>,
      eventType: json['event_type'] as String,
      id: json['id'] as String,
      occurredAt: json['occurred_at'] as String,
    );

Map<String, dynamic> _$IncidentEventToJson(IncidentEvent instance) =>
    <String, dynamic>{
      'actor_id': instance.actorId,
      'actor_name': instance.actorName,
      'detail': instance.detail,
      'event_type': instance.eventType,
      'id': instance.id,
      'occurred_at': instance.occurredAt,
    };
