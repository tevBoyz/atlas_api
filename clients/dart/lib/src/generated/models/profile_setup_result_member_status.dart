// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// The contact row's stored status: `declined` when it was left unchanged because the circle is full.
@JsonEnum()
enum ProfileSetupResultMemberStatus {
  @JsonValue('pending')
  pending('pending'),
  @JsonValue('active')
  active('active'),
  @JsonValue('declined')
  declined('declined'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const ProfileSetupResultMemberStatus(this.json);

  factory ProfileSetupResultMemberStatus.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<ProfileSetupResultMemberStatus> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
