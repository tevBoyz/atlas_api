// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'login_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LoginRequest _$LoginRequestFromJson(Map<String, dynamic> json) => LoginRequest(
  device: DeviceInfo.fromJson(json['device'] as Map<String, dynamic>),
  password: json['password'] as String,
  email: json['email'] as String?,
  phone: json['phone'] as String?,
);

Map<String, dynamic> _$LoginRequestToJson(LoginRequest instance) =>
    <String, dynamic>{
      'device': instance.device,
      'email': instance.email,
      'password': instance.password,
      'phone': instance.phone,
    };
