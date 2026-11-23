// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// "responding" (I am responding) or "unable" (unable to respond). Anything else is 422 incident_response:invalid_status.
@JsonEnum()
enum IncidentResponseRequestStatus {
  @JsonValue('responding')
  responding('responding'),
  @JsonValue('unable')
  unable('unable'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const IncidentResponseRequestStatus(this.json);

  factory IncidentResponseRequestStatus.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<IncidentResponseRequestStatus> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
