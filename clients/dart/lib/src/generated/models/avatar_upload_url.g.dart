// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'avatar_upload_url.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

AvatarUploadUrl _$AvatarUploadUrlFromJson(Map<String, dynamic> json) =>
    AvatarUploadUrl(
      expiresAt: json['expires_at'] as String,
      headers: Map<String, String>.from(json['headers'] as Map),
      method: json['method'] as String,
      objectPath: json['object_path'] as String,
      uploadUrl: json['upload_url'] as String,
    );

Map<String, dynamic> _$AvatarUploadUrlToJson(AvatarUploadUrl instance) =>
    <String, dynamic>{
      'expires_at': instance.expiresAt,
      'headers': instance.headers,
      'method': instance.method,
      'object_path': instance.objectPath,
      'upload_url': instance.uploadUrl,
    };
