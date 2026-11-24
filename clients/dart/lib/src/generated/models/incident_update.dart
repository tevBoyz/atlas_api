// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'incident_update_preset.dart';

part 'incident_update.g.dart';

@JsonSerializable()
class IncidentUpdate {
  const IncidentUpdate({
    required this.createdAt,
    required this.id,
    required this.preset,
    required this.text,
  });

  factory IncidentUpdate.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$IncidentUpdateFromJson(json), json);

  /// When the server stored the update.
  @JsonKey(name: 'created_at')
  final String createdAt;

  /// The update (its incident event id).
  final String id;

  /// The quick update, or null for a free-text update.
  final IncidentUpdatePreset? preset;

  /// The free text (trimmed), or null for a quick update.
  final String? text;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$IncidentUpdateToJson(this));
}
