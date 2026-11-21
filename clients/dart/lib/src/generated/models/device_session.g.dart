// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'device_session.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DeviceSession _$DeviceSessionFromJson(Map<String, dynamic> json) =>
    DeviceSession(
      createdAt: json['created_at'] as String,
      current: json['current'] as bool,
      deviceName: json['device_name'] as String?,
      id: json['id'] as String,
      lastSeenAt: json['last_seen_at'] as String,
      platform: json['platform'] == null
          ? null
          : DevicePlatform.fromJson(json['platform'] as String),
    );

Map<String, dynamic> _$DeviceSessionToJson(DeviceSession instance) =>
    <String, dynamic>{
      'created_at': instance.createdAt,
      'current': instance.current,
      'device_name': instance.deviceName,
      'id': instance.id,
      'last_seen_at': instance.lastSeenAt,
      'platform': instance.platform,
    };
