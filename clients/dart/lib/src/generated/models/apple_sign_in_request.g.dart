// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'apple_sign_in_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

AppleSignInRequest _$AppleSignInRequestFromJson(Map<String, dynamic> json) =>
    AppleSignInRequest(
      device: DeviceInfo.fromJson(json['device'] as Map<String, dynamic>),
      idToken: json['id_token'] as String,
      fullName: json['full_name'] as String?,
      nonce: json['nonce'] as String?,
    );

Map<String, dynamic> _$AppleSignInRequestToJson(AppleSignInRequest instance) =>
    <String, dynamic>{
      'device': instance.device,
      'full_name': instance.fullName,
      'id_token': instance.idToken,
      'nonce': instance.nonce,
    };
