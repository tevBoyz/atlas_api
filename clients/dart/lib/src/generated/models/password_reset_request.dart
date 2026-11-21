// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_info.dart';

part 'password_reset_request.g.dart';

@JsonSerializable()
class PasswordResetRequest {
  const PasswordResetRequest({
    required this.device,
    required this.newPassword,
    required this.token,
  });

  factory PasswordResetRequest.fromJson(Map<String, Object?> json) =>
      _$PasswordResetRequestFromJson(json);

  final DeviceInfo device;
  @JsonKey(name: 'new_password')
  final String newPassword;

  /// The `token` query value of the emailed recovery link.
  final String token;

  Map<String, Object?> toJson() => _$PasswordResetRequestToJson(this);
}
