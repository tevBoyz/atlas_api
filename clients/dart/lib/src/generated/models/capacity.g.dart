// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'capacity.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Capacity _$CapacityFromJson(Map<String, dynamic> json) => Capacity(
  activeCount: (json['active_count'] as num).toInt(),
  available: (json['available'] as num).toInt(),
  limit: (json['limit'] as num).toInt(),
  pendingCount: (json['pending_count'] as num).toInt(),
  used: (json['used'] as num).toInt(),
);

Map<String, dynamic> _$CapacityToJson(Capacity instance) => <String, dynamic>{
  'active_count': instance.activeCount,
  'available': instance.available,
  'limit': instance.limit,
  'pending_count': instance.pendingCount,
  'used': instance.used,
};
