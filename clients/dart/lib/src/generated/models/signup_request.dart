// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_info.dart';

part 'signup_request.g.dart';

@JsonSerializable()
class SignupRequest {
  const SignupRequest({
    required this.device,
    required this.email,
    required this.fullName,
    required this.password,
    required this.phone,
  });

  factory SignupRequest.fromJson(Map<String, Object?> json) =>
      _$SignupRequestFromJson(json);

  final DeviceInfo device;
  final String email;
  @JsonKey(name: 'full_name')
  final String fullName;

  /// 8-128 characters: lowercase, uppercase, digit.
  final String password;

  /// `+E.164`; stored unverified (verify it with the OTP routes).
  final String phone;

  Map<String, Object?> toJson() => _$SignupRequestToJson(this);
}
