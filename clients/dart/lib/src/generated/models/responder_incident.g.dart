// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'responder_incident.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ResponderIncident _$ResponderIncidentFromJson(Map<String, dynamic> json) =>
    ResponderIncident(
      activatedAt: json['activated_at'] as String,
      autoClosed: json['auto_closed'] as bool,
      emergencyType: ResponderIncidentEmergencyType.fromJson(
        json['emergency_type'] as String,
      ),
      id: json['id'] as String,
      renotifiedAt: json['renotified_at'] as String?,
      residentName: json['resident_name'] as String,
      resolvedAt: json['resolved_at'] as String?,
      resolvedReason: json['resolved_reason'] as String?,
      sentAt: json['sent_at'] as String?,
      status: ResponderIncidentStatus.fromJson(json['status'] as String),
    );

Map<String, dynamic> _$ResponderIncidentToJson(ResponderIncident instance) =>
    <String, dynamic>{
      'activated_at': instance.activatedAt,
      'auto_closed': instance.autoClosed,
      'emergency_type': instance.emergencyType,
      'id': instance.id,
      'renotified_at': instance.renotifiedAt,
      'resident_name': instance.residentName,
      'resolved_at': instance.resolvedAt,
      'resolved_reason': instance.resolvedReason,
      'sent_at': instance.sentAt,
      'status': instance.status,
    };
