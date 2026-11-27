// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'signup_verification.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SignupVerification _$SignupVerificationFromJson(Map<String, dynamic> json) =>
    SignupVerification(
      channel: SignupVerificationChannel.fromJson(json['channel'] as String),
      expiresInSeconds: (json['expires_in_seconds'] as num).toInt(),
    );

Map<String, dynamic> _$SignupVerificationToJson(SignupVerification instance) =>
    <String, dynamic>{
      'channel': instance.channel,
      'expires_in_seconds': instance.expiresInSeconds,
    };
