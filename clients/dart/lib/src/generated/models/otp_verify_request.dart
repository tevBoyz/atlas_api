// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'device_info.dart';
import 'otp_purpose.dart';

part 'otp_verify_request.g.dart';

@JsonSerializable()
class OtpVerifyRequest {
  const OtpVerifyRequest({
    required this.code,
    required this.phone,
    required this.purpose,
    this.device,
  });

  factory OtpVerifyRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$OtpVerifyRequestFromJson(json), json);

  /// 6 digits.
  final String code;

  /// Required for `sign_in`.
  final DeviceInfo? device;
  final String phone;
  final OtpPurpose purpose;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$OtpVerifyRequestToJson(this));
}
