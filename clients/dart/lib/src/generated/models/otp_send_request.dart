// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'otp_send_request_purpose.dart';

part 'otp_send_request.g.dart';

@JsonSerializable()
class OtpSendRequest {
  const OtpSendRequest({required this.phone, required this.purpose});

  factory OtpSendRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$OtpSendRequestFromJson(json), json);

  /// `+E.164`.
  final String phone;

  /// `sign_in` (no access token) or `verify_phone` (the signed-in user's own number; send the access token).
  final OtpSendRequestPurpose purpose;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$OtpSendRequestToJson(this));
}
