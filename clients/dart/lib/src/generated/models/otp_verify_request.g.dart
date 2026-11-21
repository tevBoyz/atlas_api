// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'otp_verify_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OtpVerifyRequest _$OtpVerifyRequestFromJson(Map<String, dynamic> json) =>
    OtpVerifyRequest(
      code: json['code'] as String,
      phone: json['phone'] as String,
      purpose: OtpPurpose.fromJson(json['purpose'] as String),
      device: json['device'] == null
          ? null
          : DeviceInfo.fromJson(json['device'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$OtpVerifyRequestToJson(OtpVerifyRequest instance) =>
    <String, dynamic>{
      'code': instance.code,
      'device': instance.device,
      'phone': instance.phone,
      'purpose': instance.purpose,
    };
