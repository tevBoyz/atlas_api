// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'device_platform.dart';

part 'device_session.g.dart';

@JsonSerializable()
class DeviceSession {
  const DeviceSession({
    required this.createdAt,
    required this.current,
    required this.deviceName,
    required this.id,
    required this.lastSeenAt,
    required this.platform,
  });

  factory DeviceSession.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$DeviceSessionFromJson(json), json);

  @JsonKey(name: 'created_at')
  final String createdAt;
  final bool current;
  @JsonKey(name: 'device_name')
  final String? deviceName;
  final String id;
  @JsonKey(name: 'last_seen_at')
  final String lastSeenAt;
  final DevicePlatform? platform;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$DeviceSessionToJson(this));
}
