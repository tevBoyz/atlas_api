// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'set_avatar_request.g.dart';

@JsonSerializable()
class SetAvatarRequest {
  const SetAvatarRequest({required this.objectPath});

  factory SetAvatarRequest.fromJson(Map<String, Object?> json) =>
      _$SetAvatarRequestFromJson(json);

  /// An uploaded object in the caller's own folder (`{uid}/...`), or null to remove the photo.
  @JsonKey(name: 'object_path')
  final String? objectPath;

  Map<String, Object?> toJson() => _$SetAvatarRequestToJson(this);
}
