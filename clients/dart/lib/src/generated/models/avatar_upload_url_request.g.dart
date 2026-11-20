// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'avatar_upload_url_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

AvatarUploadUrlRequest _$AvatarUploadUrlRequestFromJson(
  Map<String, dynamic> json,
) => AvatarUploadUrlRequest(
  contentLength: (json['content_length'] as num).toInt(),
  contentType: AvatarUploadUrlRequestContentType.fromJson(
    json['content_type'] as String,
  ),
);

Map<String, dynamic> _$AvatarUploadUrlRequestToJson(
  AvatarUploadUrlRequest instance,
) => <String, dynamic>{
  'content_length': instance.contentLength,
  'content_type': instance.contentType,
};
