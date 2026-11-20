// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum BloodType {
  /// Incorrect name has been replaced. Original name: `A+`.
  @JsonValue('A+')
  undefined0('A+'),
  @JsonValue('A-')
  a('A-'),

  /// Incorrect name has been replaced. Original name: `B+`.
  @JsonValue('B+')
  undefined1('B+'),
  @JsonValue('B-')
  b('B-'),

  /// Incorrect name has been replaced. Original name: `AB+`.
  @JsonValue('AB+')
  undefined2('AB+'),
  @JsonValue('AB-')
  ab('AB-'),

  /// Incorrect name has been replaced. Original name: `O+`.
  @JsonValue('O+')
  undefined3('O+'),
  @JsonValue('O-')
  o('O-'),
  @JsonValue('Unknown')
  unknown('Unknown'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const BloodType(this.json);

  factory BloodType.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<BloodType> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
