// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'avatar_upload_url.g.dart';

@JsonSerializable()
class AvatarUploadUrl {
  const AvatarUploadUrl({
    required this.expiresAt,
    required this.headers,
    required this.method,
    required this.objectPath,
    required this.uploadUrl,
  });

  factory AvatarUploadUrl.fromJson(Map<String, Object?> json) =>
      _$AvatarUploadUrlFromJson(json);

  /// ISO-8601 UTC time after which the upload URL is refused.
  @JsonKey(name: 'expires_at')
  final String expiresAt;

  /// Headers to send with the upload (`content-type`).
  final Map<String, String> headers;
  final String method;

  /// `{uid}/avatar-{uuid}.{jpg|png|webp}`: pass it to `PUT /v1/me/profile/avatar`.
  @JsonKey(name: 'object_path')
  final String objectPath;

  /// Send the photo bytes here once, before `expires_at`.
  @JsonKey(name: 'upload_url')
  final String uploadUrl;

  Map<String, Object?> toJson() => _$AvatarUploadUrlToJson(this);
}
