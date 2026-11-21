// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'otp_verified.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OtpVerified _$OtpVerifiedFromJson(Map<String, dynamic> json) => OtpVerified(
  user: User.fromJson(json['user'] as Map<String, dynamic>),
  accessToken: json['access_token'] as String?,
  accessTokenExpiresAt: json['access_token_expires_at'] as String?,
  refreshToken: json['refresh_token'] as String?,
  refreshTokenExpiresAt: json['refresh_token_expires_at'] as String?,
  sessionId: json['session_id'] as String?,
);

Map<String, dynamic> _$OtpVerifiedToJson(OtpVerified instance) =>
    <String, dynamic>{
      'access_token': instance.accessToken,
      'access_token_expires_at': instance.accessTokenExpiresAt,
      'refresh_token': instance.refreshToken,
      'refresh_token_expires_at': instance.refreshTokenExpiresAt,
      'session_id': instance.sessionId,
      'user': instance.user,
    };
