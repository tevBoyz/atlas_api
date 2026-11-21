// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'phone_change_verify_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PhoneChangeVerifyRequest _$PhoneChangeVerifyRequestFromJson(
  Map<String, dynamic> json,
) => PhoneChangeVerifyRequest(
  code: json['code'] as String,
  phone: json['phone'] as String,
);

Map<String, dynamic> _$PhoneChangeVerifyRequestToJson(
  PhoneChangeVerifyRequest instance,
) => <String, dynamic>{'code': instance.code, 'phone': instance.phone};
