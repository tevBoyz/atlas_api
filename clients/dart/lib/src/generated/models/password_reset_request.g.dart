// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'password_reset_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PasswordResetRequest _$PasswordResetRequestFromJson(
  Map<String, dynamic> json,
) => PasswordResetRequest(
  device: DeviceInfo.fromJson(json['device'] as Map<String, dynamic>),
  newPassword: json['new_password'] as String,
  token: json['token'] as String,
);

Map<String, dynamic> _$PasswordResetRequestToJson(
  PasswordResetRequest instance,
) => <String, dynamic>{
  'device': instance.device,
  'new_password': instance.newPassword,
  'token': instance.token,
};
