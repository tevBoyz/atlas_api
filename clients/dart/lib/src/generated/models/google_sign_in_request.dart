// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_info.dart';

part 'google_sign_in_request.g.dart';

@JsonSerializable()
class GoogleSignInRequest {
  const GoogleSignInRequest({
    required this.device,
    required this.idToken,
    this.accessToken,
  });

  factory GoogleSignInRequest.fromJson(Map<String, Object?> json) =>
      _$GoogleSignInRequestFromJson(json);

  @JsonKey(name: 'access_token')
  final String? accessToken;
  final DeviceInfo device;
  @JsonKey(name: 'id_token')
  final String idToken;

  Map<String, Object?> toJson() => _$GoogleSignInRequestToJson(this);
}
