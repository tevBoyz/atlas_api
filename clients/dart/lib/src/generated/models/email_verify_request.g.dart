// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'email_verify_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EmailVerifyRequest _$EmailVerifyRequestFromJson(Map<String, dynamic> json) =>
    EmailVerifyRequest(
      device: DeviceInfo.fromJson(json['device'] as Map<String, dynamic>),
      token: json['token'] as String,
    );

Map<String, dynamic> _$EmailVerifyRequestToJson(EmailVerifyRequest instance) =>
    <String, dynamic>{'device': instance.device, 'token': instance.token};
