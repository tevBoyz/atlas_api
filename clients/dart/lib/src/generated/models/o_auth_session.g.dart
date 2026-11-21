// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'o_auth_session.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OAuthSession _$OAuthSessionFromJson(Map<String, dynamic> json) => OAuthSession(
  accessToken: json['access_token'] as String,
  accessTokenExpiresAt: json['access_token_expires_at'] as String,
  isNewUser: json['is_new_user'] as bool,
  refreshToken: json['refresh_token'] as String,
  refreshTokenExpiresAt: json['refresh_token_expires_at'] as String,
  sessionId: json['session_id'] as String,
  user: User.fromJson(json['user'] as Map<String, dynamic>),
);

Map<String, dynamic> _$OAuthSessionToJson(OAuthSession instance) =>
    <String, dynamic>{
      'access_token': instance.accessToken,
      'access_token_expires_at': instance.accessTokenExpiresAt,
      'is_new_user': instance.isNewUser,
      'refresh_token': instance.refreshToken,
      'refresh_token_expires_at': instance.refreshTokenExpiresAt,
      'session_id': instance.sessionId,
      'user': instance.user,
    };
