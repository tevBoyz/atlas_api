// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'device_platform.dart';
import 'push_provider.dart';

part 'register_device_request.g.dart';

@JsonSerializable()
class RegisterDeviceRequest {
  const RegisterDeviceRequest({
    required this.appVersion,
    required this.platform,
    this.pushProvider,
    this.pushToken,
  });

  factory RegisterDeviceRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$RegisterDeviceRequestFromJson(json), json);

  /// Trimmed; 1-64 characters.
  @JsonKey(name: 'app_version')
  final String appVersion;
  final DevicePlatform platform;

  /// Who issued `push_token`: `fcm` or `apns`. Sent together with `push_token`.
  @JsonKey(name: 'push_provider')
  final PushProvider? pushProvider;

  /// The device push token. Left out (with `push_provider`): the stored token is kept. `null`: the stored token is cleared. A token is on one device only: registering it here clears it from any other device.
  @JsonKey(name: 'push_token')
  final String? pushToken;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$RegisterDeviceRequestToJson(this));
}
