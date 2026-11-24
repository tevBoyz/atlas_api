// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// The quick update, or null for a free-text update.
@JsonEnum()
enum IncidentUpdatePreset {
  @JsonValue('situation_worsening')
  situationWorsening('situation_worsening'),
  @JsonValue('help_is_here')
  helpIsHere('help_is_here'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const IncidentUpdatePreset(this.json);

  factory IncidentUpdatePreset.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<IncidentUpdatePreset> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
