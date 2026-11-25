// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'preset.dart';
import 'reason.dart';

part 'detail.g.dart';

@JsonSerializable()
class Detail {
  const Detail({this.preset, this.reason, this.text});

  factory Detail.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$DetailFromJson(json), json);

  /// status_update: the quick update, or null for a text update.
  final Preset? preset;

  /// ended: "safe" (the resident marked safe) or "ended" (closed automatically after inactivity).
  final Reason? reason;

  /// status_update: the free text (1-250 characters), or null for a preset.
  final String? text;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$DetailToJson(this));
}
