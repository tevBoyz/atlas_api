// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// "all" (default): the caller's own alerts and their circle alerts together; "mine": only alerts the caller raised (My Emergencies); "circle": only alerts of others in circles the caller is an active member of, inside the access window (Circle Alerts).
@JsonEnum()
enum Category {
  @JsonValue('all')
  all('all'),
  @JsonValue('mine')
  mine('mine'),
  @JsonValue('circle')
  circle('circle'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const Category(this.json);

  factory Category.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<Category> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
