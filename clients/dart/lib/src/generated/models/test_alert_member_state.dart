// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum TestAlertMemberState {
  @JsonValue('pending')
  pending('pending'),
  @JsonValue('delivered')
  delivered('delivered'),
  @JsonValue('seen')
  seen('seen'),
  @JsonValue('failed')
  failed('failed'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const TestAlertMemberState(this.json);

  factory TestAlertMemberState.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<TestAlertMemberState> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
