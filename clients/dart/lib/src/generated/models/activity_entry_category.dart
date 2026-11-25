// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// "mine" = an alert the caller raised; "circle" = a circle alert of someone else.
@JsonEnum()
enum ActivityEntryCategory {
  @JsonValue('mine')
  mine('mine'),
  @JsonValue('circle')
  circle('circle'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const ActivityEntryCategory(this.json);

  factory ActivityEntryCategory.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<ActivityEntryCategory> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
