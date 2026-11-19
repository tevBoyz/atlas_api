// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'safety_circle.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SafetyCircle _$SafetyCircleFromJson(Map<String, dynamic> json) => SafetyCircle(
  createdAt: json['created_at'] as String,
  id: json['id'] as String,
  name: json['name'] as String,
  ownerId: json['owner_id'] as String,
  updatedAt: json['updated_at'] as String,
);

Map<String, dynamic> _$SafetyCircleToJson(SafetyCircle instance) =>
    <String, dynamic>{
      'created_at': instance.createdAt,
      'id': instance.id,
      'name': instance.name,
      'owner_id': instance.ownerId,
      'updated_at': instance.updatedAt,
    };
