// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'user.dart';

part 'otp_verified.g.dart';

@JsonSerializable()
class OtpVerified {
  const OtpVerified({
    required this.user,
    this.accessToken,
    this.accessTokenExpiresAt,
    this.refreshToken,
    this.refreshTokenExpiresAt,
    this.sessionId,
  });

  factory OtpVerified.fromJson(Map<String, Object?> json) =>
      _$OtpVerifiedFromJson(json);

  /// JWT, 15 minutes. Send as `Authorization: Bearer ...`.
  @JsonKey(name: 'access_token')
  final String? accessToken;
  @JsonKey(name: 'access_token_expires_at')
  final String? accessTokenExpiresAt;

  /// Opaque, single use: every refresh returns a new one. Keep it in secure storage.
  @JsonKey(name: 'refresh_token')
  final String? refreshToken;

  /// Refresh before this: a session not refreshed for 7 days ends (sign in again).
  @JsonKey(name: 'refresh_token_expires_at')
  final String? refreshTokenExpiresAt;
  @JsonKey(name: 'session_id')
  final String? sessionId;
  final User user;

  Map<String, Object?> toJson() => _$OtpVerifiedToJson(this);
}
