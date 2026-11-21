// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'password_change_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PasswordChangeRequest _$PasswordChangeRequestFromJson(
  Map<String, dynamic> json,
) => PasswordChangeRequest(
  currentPassword: json['current_password'] as String,
  newPassword: json['new_password'] as String,
);

Map<String, dynamic> _$PasswordChangeRequestToJson(
  PasswordChangeRequest instance,
) => <String, dynamic>{
  'current_password': instance.currentPassword,
  'new_password': instance.newPassword,
};
