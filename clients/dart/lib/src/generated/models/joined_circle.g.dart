// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'joined_circle.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

JoinedCircle _$JoinedCircleFromJson(Map<String, dynamic> json) => JoinedCircle(
  activeIncidentId: json['active_incident_id'] as String?,
  activeMemberCount: (json['active_member_count'] as num).toInt(),
  capacityUsed: (json['capacity_used'] as num).toInt(),
  circleId: json['circle_id'] as String,
  joinedAt: json['joined_at'] as String,
  memberId: json['member_id'] as String,
  name: json['name'] as String,
  ownerName: json['owner_name'] as String?,
  role: JoinedCircleRole.fromJson(json['role'] as String),
  status: json['status'] as String,
);

Map<String, dynamic> _$JoinedCircleToJson(JoinedCircle instance) =>
    <String, dynamic>{
      'active_incident_id': instance.activeIncidentId,
      'active_member_count': instance.activeMemberCount,
      'capacity_used': instance.capacityUsed,
      'circle_id': instance.circleId,
      'joined_at': instance.joinedAt,
      'member_id': instance.memberId,
      'name': instance.name,
      'owner_name': instance.ownerName,
      'role': instance.role,
      'status': instance.status,
    };
