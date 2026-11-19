// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'recent_incident.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

RecentIncident _$RecentIncidentFromJson(Map<String, dynamic> json) =>
    RecentIncident(
      activatedAt: json['activated_at'] as String,
      emergencyType: RecentIncidentEmergencyType.fromJson(
        json['emergency_type'] as String,
      ),
      id: json['id'] as String,
      resolvedAt: json['resolved_at'] as String?,
      resolvedReason: json['resolved_reason'] as String?,
      sentAt: json['sent_at'] as String?,
      status: RecentIncidentStatus.fromJson(json['status'] as String),
    );

Map<String, dynamic> _$RecentIncidentToJson(RecentIncident instance) =>
    <String, dynamic>{
      'activated_at': instance.activatedAt,
      'emergency_type': instance.emergencyType,
      'id': instance.id,
      'resolved_at': instance.resolvedAt,
      'resolved_reason': instance.resolvedReason,
      'sent_at': instance.sentAt,
      'status': instance.status,
    };
