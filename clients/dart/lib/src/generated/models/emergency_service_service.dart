// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// Which service. Clients show unknown future values as a plain number.
@JsonEnum()
enum EmergencyServiceService {
  @JsonValue('ambulance')
  ambulance('ambulance'),
  @JsonValue('police')
  police('police'),
  @JsonValue('fire_rescue')
  fireRescue('fire_rescue'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const EmergencyServiceService(this.json);

  factory EmergencyServiceService.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<EmergencyServiceService> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
