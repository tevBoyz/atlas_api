// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'register_device_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

RegisterDeviceRequest _$RegisterDeviceRequestFromJson(
  Map<String, dynamic> json,
) => RegisterDeviceRequest(
  appVersion: json['app_version'] as String,
  platform: DevicePlatform.fromJson(json['platform'] as String),
  pushProvider: json['push_provider'] == null
      ? null
      : PushProvider.fromJson(json['push_provider'] as String),
  pushToken: json['push_token'] as String?,
  timeZone: json['time_zone'] as String?,
);

Map<String, dynamic> _$RegisterDeviceRequestToJson(
  RegisterDeviceRequest instance,
) => <String, dynamic>{
  'app_version': instance.appVersion,
  'platform': instance.platform,
  'push_provider': instance.pushProvider,
  'push_token': instance.pushToken,
  'time_zone': instance.timeZone,
};
