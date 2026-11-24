// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// A quick update: "situation_worsening" (Situation worsening) or "help_is_here" (Help is here). Give exactly one of preset or text (null counts as not given); else 422 incident_updates:invalid_update.
@JsonEnum()
enum SendIncidentUpdateRequestPreset {
  @JsonValue('situation_worsening')
  situationWorsening('situation_worsening'),
  @JsonValue('help_is_here')
  helpIsHere('help_is_here'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const SendIncidentUpdateRequestPreset(this.json);

  factory SendIncidentUpdateRequestPreset.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<SendIncidentUpdateRequestPreset> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
