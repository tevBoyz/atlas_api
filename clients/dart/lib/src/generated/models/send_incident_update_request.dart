// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'send_incident_update_request_preset.dart';

part 'send_incident_update_request.g.dart';

@JsonSerializable()
class SendIncidentUpdateRequest {
  const SendIncidentUpdateRequest({this.preset, this.text});

  factory SendIncidentUpdateRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$SendIncidentUpdateRequestFromJson(json), json);

  /// A quick update: "situation_worsening" (Situation worsening) or "help_is_here" (Help is here). Give exactly one of preset or text (null counts as not given); else 422 incident_updates:invalid_update.
  final SendIncidentUpdateRequestPreset? preset;

  /// A free-text update: trimmed of white space, then 1 to 250 characters. Give exactly one of preset or text; else 422 incident_updates:invalid_update.
  final String? text;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$SendIncidentUpdateRequestToJson(this));
}
