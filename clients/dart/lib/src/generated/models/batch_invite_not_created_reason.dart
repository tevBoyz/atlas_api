// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum BatchInviteNotCreatedReason {
  @JsonValue('invalid_invite')
  invalidInvite('invalid_invite'),
  @JsonValue('invalid_phone')
  invalidPhone('invalid_phone'),
  @JsonValue('invalid_display_name')
  invalidDisplayName('invalid_display_name'),
  @JsonValue('circle_full')
  circleFull('circle_full'),
  @JsonValue('duplicate_membership')
  duplicateMembership('duplicate_membership'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const BatchInviteNotCreatedReason(this.json);

  factory BatchInviteNotCreatedReason.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<BatchInviteNotCreatedReason> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
