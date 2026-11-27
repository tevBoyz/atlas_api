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
    required this.fullName,
    required this.password,
    this.email,
    this.phone,
  });

  factory SignupRequest.fromJson(Map<String, Object?> json) =>
      _$SignupRequestFromJson(json);

  final DeviceInfo device;

  /// D78: optional; at least one of `email` / `phone` (else 422 `signup:contact_required`).
  final String? email;
  @JsonKey(name: 'full_name')
  final String fullName;

  /// 8-128 characters: lowercase, uppercase, digit.
  final String password;

  /// D78: optional `+E.164`; stored unconfirmed, a code is texted to it (verify with `POST /v1/auth/otp/verify`, purpose `sign_in`).
  final String? phone;

  Map<String, Object?> toJson() => _$SignupRequestToJson(this);
}
