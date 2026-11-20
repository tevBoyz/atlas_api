// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'device_registered.g.dart';

@JsonSerializable()
class DeviceRegistered {
  const DeviceRegistered({required this.deviceId});

  factory DeviceRegistered.fromJson(Map<String, Object?> json) =>
      _$DeviceRegisteredFromJson(json);

  @JsonKey(name: 'device_id')
  final String deviceId;

  Map<String, Object?> toJson() => _$DeviceRegisteredToJson(this);
}
