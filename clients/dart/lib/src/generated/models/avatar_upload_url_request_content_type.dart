// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// `profiles:invalid_content_type` otherwise.
@JsonEnum()
enum AvatarUploadUrlRequestContentType {
  /// Incorrect name has been replaced. Original name: `image/jpeg`.
  @JsonValue('image/jpeg')
  undefined0('image/jpeg'),

  /// Incorrect name has been replaced. Original name: `image/png`.
  @JsonValue('image/png')
  undefined1('image/png'),

  /// Incorrect name has been replaced. Original name: `image/webp`.
  @JsonValue('image/webp')
  undefined2('image/webp'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const AvatarUploadUrlRequestContentType(this.json);

  factory AvatarUploadUrlRequestContentType.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<AvatarUploadUrlRequestContentType> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
