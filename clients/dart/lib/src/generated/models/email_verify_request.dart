// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_info.dart';

part 'email_verify_request.g.dart';

@JsonSerializable()
class EmailVerifyRequest {
  const EmailVerifyRequest({required this.device, required this.token});

  factory EmailVerifyRequest.fromJson(Map<String, Object?> json) =>
      _$EmailVerifyRequestFromJson(json);

  final DeviceInfo device;

  /// The `token` query value of the emailed link.
  final String token;

  Map<String, Object?> toJson() => _$EmailVerifyRequestToJson(this);
}
