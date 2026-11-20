// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum PreferredLanguage {
  @JsonValue('en')
  en('en'),
  @JsonValue('wo')
  wo('wo'),
  @JsonValue('mnk')
  mnk('mnk'),
  @JsonValue('ff')
  ff('ff'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const PreferredLanguage(this.json);

  factory PreferredLanguage.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<PreferredLanguage> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
