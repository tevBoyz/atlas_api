// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'google_sign_in_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

GoogleSignInRequest _$GoogleSignInRequestFromJson(Map<String, dynamic> json) =>
    GoogleSignInRequest(
      device: DeviceInfo.fromJson(json['device'] as Map<String, dynamic>),
      idToken: json['id_token'] as String,
      accessToken: json['access_token'] as String?,
    );

Map<String, dynamic> _$GoogleSignInRequestToJson(
  GoogleSignInRequest instance,
) => <String, dynamic>{
  'access_token': instance.accessToken,
  'device': instance.device,
  'id_token': instance.idToken,
};
