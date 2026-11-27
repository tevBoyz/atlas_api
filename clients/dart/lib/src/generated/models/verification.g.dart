// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'verification.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Verification _$VerificationFromJson(Map<String, dynamic> json) => Verification(
  channel: Channel.fromJson(json['channel'] as String),
  expiresInSeconds: (json['expires_in_seconds'] as num).toInt(),
);

Map<String, dynamic> _$VerificationToJson(Verification instance) =>
    <String, dynamic>{
      'channel': instance.channel,
      'expires_in_seconds': instance.expiresInSeconds,
    };
