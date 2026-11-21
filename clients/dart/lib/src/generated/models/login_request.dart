// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_info.dart';

part 'login_request.g.dart';

@JsonSerializable()
class LoginRequest {
  const LoginRequest({
    required this.device,
    required this.password,
    this.email,
    this.phone,
  });

  factory LoginRequest.fromJson(Map<String, Object?> json) =>
      _$LoginRequestFromJson(json);

  final DeviceInfo device;

  /// Exactly one of `email` / `phone`.
  final String? email;
  final String password;
  final String? phone;

  Map<String, Object?> toJson() => _$LoginRequestToJson(this);
}
