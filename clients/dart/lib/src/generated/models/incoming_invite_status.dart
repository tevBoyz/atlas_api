// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// The lookup status (spec §5.3). Accepted (`consumed`) invitations are not listed.
@JsonEnum()
enum IncomingInviteStatus {
  @JsonValue('pending')
  pending('pending'),
  @JsonValue('expired')
  expired('expired'),
  @JsonValue('canceled')
  canceled('canceled'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const IncomingInviteStatus(this.json);

  factory IncomingInviteStatus.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<IncomingInviteStatus> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
