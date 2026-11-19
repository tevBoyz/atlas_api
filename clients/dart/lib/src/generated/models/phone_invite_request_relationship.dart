// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// Spec §4.4: one of the 7 relationship values.
@JsonEnum()
enum PhoneInviteRequestRelationship {
  @JsonValue('spouse')
  spouse('spouse'),
  @JsonValue('partner')
  partner('partner'),
  @JsonValue('parent')
  parent('parent'),
  @JsonValue('child')
  child('child'),
  @JsonValue('sibling')
  sibling('sibling'),
  @JsonValue('friend')
  friend('friend'),
  @JsonValue('other')
  other('other'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const PhoneInviteRequestRelationship(this.json);

  factory PhoneInviteRequestRelationship.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<PhoneInviteRequestRelationship> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
