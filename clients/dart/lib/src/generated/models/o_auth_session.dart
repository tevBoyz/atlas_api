// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'user.dart';

part 'o_auth_session.g.dart';

@JsonSerializable()
class OAuthSession {
  const OAuthSession({
    required this.accessToken,
    required this.accessTokenExpiresAt,
    required this.isNewUser,
    required this.refreshToken,
    required this.refreshTokenExpiresAt,
    required this.sessionId,
    required this.user,
  });

  factory OAuthSession.fromJson(Map<String, Object?> json) =>
      _$OAuthSessionFromJson(json);

  /// JWT, 15 minutes. Send as `Authorization: Bearer ...`.
  @JsonKey(name: 'access_token')
  final String accessToken;
  @JsonKey(name: 'access_token_expires_at')
  final String accessTokenExpiresAt;

  /// True when this sign-in created the account.
  @JsonKey(name: 'is_new_user')
  final bool isNewUser;

  /// Opaque, single use: every refresh returns a new one. Keep it in secure storage.
  @JsonKey(name: 'refresh_token')
  final String refreshToken;

  /// Refresh before this: a session not refreshed for 7 days ends (sign in again).
  @JsonKey(name: 'refresh_token_expires_at')
  final String refreshTokenExpiresAt;
  @JsonKey(name: 'session_id')
  final String sessionId;
  final User user;

  Map<String, Object?> toJson() => _$OAuthSessionToJson(this);
}
