// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'device_platform.dart';

part 'device_info.g.dart';

@JsonSerializable()
class DeviceInfo {
  const DeviceInfo({
    required this.appVersion,
    required this.platform,
    this.deviceName,
  });

  factory DeviceInfo.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$DeviceInfoFromJson(json), json);

  /// Trimmed; 1-64 characters.
  @JsonKey(name: 'app_version')
  final String appVersion;

  /// Shown in the session list, e.g. "Pixel 8". Optional.
  @JsonKey(name: 'device_name')
  final String? deviceName;
  final DevicePlatform platform;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$DeviceInfoToJson(this));
}
