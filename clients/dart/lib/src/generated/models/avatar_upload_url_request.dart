// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'avatar_upload_url_request_content_type.dart';

part 'avatar_upload_url_request.g.dart';

@JsonSerializable()
class AvatarUploadUrlRequest {
  const AvatarUploadUrlRequest({
    required this.contentLength,
    required this.contentType,
  });

  factory AvatarUploadUrlRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$AvatarUploadUrlRequestFromJson(json), json);

  /// Bytes; at most 5,242,880 (`profiles:file_too_large`).
  @JsonKey(name: 'content_length')
  final int contentLength;

  /// `profiles:invalid_content_type` otherwise.
  @JsonKey(name: 'content_type')
  final AvatarUploadUrlRequestContentType contentType;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$AvatarUploadUrlRequestToJson(this));
}
