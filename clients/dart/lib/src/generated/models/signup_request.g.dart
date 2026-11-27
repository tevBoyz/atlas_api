// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'signup_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SignupRequest _$SignupRequestFromJson(Map<String, dynamic> json) =>
    SignupRequest(
      device: DeviceInfo.fromJson(json['device'] as Map<String, dynamic>),
      fullName: json['full_name'] as String,
      password: json['password'] as String,
      email: json['email'] as String?,
      phone: json['phone'] as String?,
    );

Map<String, dynamic> _$SignupRequestToJson(SignupRequest instance) =>
    <String, dynamic>{
      'device': instance.device,
      'email': instance.email,
      'full_name': instance.fullName,
      'password': instance.password,
      'phone': instance.phone,
    };
