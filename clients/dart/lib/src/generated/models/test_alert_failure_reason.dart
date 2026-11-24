// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum TestAlertFailureReason {
  @JsonValue('no_device')
  noDevice('no_device'),
  @JsonValue('invalid_token')
  invalidToken('invalid_token'),
  @JsonValue('provider_error')
  providerError('provider_error'),
  @JsonValue('channel_disabled')
  channelDisabled('channel_disabled'),
  @JsonValue('not_eligible')
  notEligible('not_eligible'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const TestAlertFailureReason(this.json);

  factory TestAlertFailureReason.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<TestAlertFailureReason> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
