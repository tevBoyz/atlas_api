// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'push_token_status.dart';

part 'device_registered.g.dart';

@JsonSerializable()
class DeviceRegistered {
  const DeviceRegistered({
    required this.deviceId,
    required this.pushTokenStatus,
  });

  factory DeviceRegistered.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$DeviceRegisteredFromJson(json), json);

  @JsonKey(name: 'device_id')
  final String deviceId;
  @JsonKey(name: 'push_token_status')
  final PushTokenStatus pushTokenStatus;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$DeviceRegisteredToJson(this));
}
