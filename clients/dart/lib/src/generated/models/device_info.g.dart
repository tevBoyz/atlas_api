// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'device_info.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DeviceInfo _$DeviceInfoFromJson(Map<String, dynamic> json) => DeviceInfo(
  appVersion: json['app_version'] as String,
  platform: DevicePlatform.fromJson(json['platform'] as String),
  deviceName: json['device_name'] as String?,
);

Map<String, dynamic> _$DeviceInfoToJson(DeviceInfo instance) =>
    <String, dynamic>{
      'app_version': instance.appVersion,
      'device_name': instance.deviceName,
      'platform': instance.platform,
    };
