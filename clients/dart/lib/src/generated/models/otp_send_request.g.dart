// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'otp_send_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OtpSendRequest _$OtpSendRequestFromJson(Map<String, dynamic> json) =>
    OtpSendRequest(
      phone: json['phone'] as String,
      purpose: OtpSendRequestPurpose.fromJson(json['purpose'] as String),
    );

Map<String, dynamic> _$OtpSendRequestToJson(OtpSendRequest instance) =>
    <String, dynamic>{'phone': instance.phone, 'purpose': instance.purpose};
