// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_info.dart';

part 'apple_sign_in_request.g.dart';

@JsonSerializable()
class AppleSignInRequest {
  const AppleSignInRequest({
    required this.device,
    required this.idToken,
    this.fullName,
    this.nonce,
  });

  factory AppleSignInRequest.fromJson(Map<String, Object?> json) =>
      _$AppleSignInRequestFromJson(json);

  final DeviceInfo device;
  @JsonKey(name: 'full_name')
  final String? fullName;
  @JsonKey(name: 'id_token')
  final String idToken;

  /// The raw nonce whose SHA-256 (hex) the app gave Apple.
  final String? nonce;

  Map<String, Object?> toJson() => _$AppleSignInRequestToJson(this);
}
