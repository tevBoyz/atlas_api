// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'activity_incident.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ActivityIncident _$ActivityIncidentFromJson(Map<String, dynamic> json) =>
    ActivityIncident(
      circleName: json['circle_name'] as String?,
      emergencyType: ActivityIncidentEmergencyType.fromJson(
        json['emergency_type'] as String,
      ),
      id: json['id'] as String,
      residentName: json['resident_name'] as String?,
      status: ActivityIncidentStatus.fromJson(json['status'] as String),
    );

Map<String, dynamic> _$ActivityIncidentToJson(ActivityIncident instance) =>
    <String, dynamic>{
      'circle_name': instance.circleName,
      'emergency_type': instance.emergencyType,
      'id': instance.id,
      'resident_name': instance.residentName,
      'status': instance.status,
    };
