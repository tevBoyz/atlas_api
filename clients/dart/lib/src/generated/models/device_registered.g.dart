// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'device_registered.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DeviceRegistered _$DeviceRegisteredFromJson(Map<String, dynamic> json) =>
    DeviceRegistered(
      deviceId: json['device_id'] as String,
      pushTokenStatus: PushTokenStatus.fromJson(
        json['push_token_status'] as String,
      ),
    );

Map<String, dynamic> _$DeviceRegisteredToJson(DeviceRegistered instance) =>
    <String, dynamic>{
      'device_id': instance.deviceId,
      'push_token_status': instance.pushTokenStatus,
    };
