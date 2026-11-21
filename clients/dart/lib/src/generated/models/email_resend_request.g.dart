// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'email_resend_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EmailResendRequest _$EmailResendRequestFromJson(Map<String, dynamic> json) =>
    EmailResendRequest(
      email: json['email'] as String,
      purpose: json['purpose'] == null
          ? null
          : EmailResendRequestPurpose.fromJson(json['purpose'] as String),
    );

Map<String, dynamic> _$EmailResendRequestToJson(EmailResendRequest instance) =>
    <String, dynamic>{'email': instance.email, 'purpose': instance.purpose};
