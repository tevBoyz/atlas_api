// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// ended: "safe" (the resident marked safe) or "ended" (closed automatically after inactivity).
@JsonEnum()
enum Reason {
  @JsonValue('safe')
  safe('safe'),
  @JsonValue('ended')
  ended('ended'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const Reason(this.json);

  factory Reason.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<Reason> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
