// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'own_circle.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OwnCircle _$OwnCircleFromJson(Map<String, dynamic> json) => OwnCircle(
  capacity: json['capacity'] == null
      ? null
      : Capacity.fromJson(json['capacity'] as Map<String, dynamic>),
  circle: json['circle'] == null
      ? null
      : SafetyCircle.fromJson(json['circle'] as Map<String, dynamic>),
  members: (json['members'] as List<dynamic>)
      .map((e) => CircleMember.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$OwnCircleToJson(OwnCircle instance) => <String, dynamic>{
  'capacity': instance.capacity,
  'circle': instance.circle,
  'members': instance.members,
};
