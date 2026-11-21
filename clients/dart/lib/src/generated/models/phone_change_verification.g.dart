// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'phone_change_verification.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PhoneChangeVerification _$PhoneChangeVerificationFromJson(
  Map<String, dynamic> json,
) => PhoneChangeVerification(
  channel: json['channel'] as String,
  expiresInSeconds: (json['expires_in_seconds'] as num).toInt(),
  resendsRemaining: (json['resends_remaining'] as num).toInt(),
);

Map<String, dynamic> _$PhoneChangeVerificationToJson(
  PhoneChangeVerification instance,
) => <String, dynamic>{
  'channel': instance.channel,
  'expires_in_seconds': instance.expiresInSeconds,
  'resends_remaining': instance.resendsRemaining,
};
