// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'otp_sent.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OtpSent _$OtpSentFromJson(Map<String, dynamic> json) => OtpSent(
  expiresInSeconds: (json['expires_in_seconds'] as num).toInt(),
  resendsRemaining: (json['resends_remaining'] as num).toInt(),
);

Map<String, dynamic> _$OtpSentToJson(OtpSent instance) => <String, dynamic>{
  'expires_in_seconds': instance.expiresInSeconds,
  'resends_remaining': instance.resendsRemaining,
};
