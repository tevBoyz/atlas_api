// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum BatchInviteSkippedReason {
  @JsonValue('already_active')
  alreadyActive('already_active'),
  @JsonValue('already_pending')
  alreadyPending('already_pending'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const BatchInviteSkippedReason(this.json);

  factory BatchInviteSkippedReason.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<BatchInviteSkippedReason> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
