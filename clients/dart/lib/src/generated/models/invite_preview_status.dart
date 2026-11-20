// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// Lookup status, or the display statuses `own_circle`, `already_member`, `circle_full`.
@JsonEnum()
enum InvitePreviewStatus {
  @JsonValue('pending')
  pending('pending'),
  @JsonValue('expired')
  expired('expired'),
  @JsonValue('consumed')
  consumed('consumed'),
  @JsonValue('canceled')
  canceled('canceled'),
  @JsonValue('not_found')
  notFound('not_found'),
  @JsonValue('own_circle')
  ownCircle('own_circle'),
  @JsonValue('already_member')
  alreadyMember('already_member'),
  @JsonValue('circle_full')
  circleFull('circle_full'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const InvitePreviewStatus(this.json);

  factory InvitePreviewStatus.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<InvitePreviewStatus> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
