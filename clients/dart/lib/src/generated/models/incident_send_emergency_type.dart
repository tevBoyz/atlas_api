// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum IncidentSendEmergencyType {
  @JsonValue('medical')
  medical('medical'),
  @JsonValue('domestic_violence')
  domesticViolence('domestic_violence'),
  @JsonValue('fire')
  fire('fire'),
  @JsonValue('burglary')
  burglary('burglary'),
  @JsonValue('other')
  other('other'),
  @JsonValue('unspecified')
  unspecified('unspecified'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const IncidentSendEmergencyType(this.json);

  factory IncidentSendEmergencyType.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<IncidentSendEmergencyType> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
