// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// `ok`: a push token is stored for this installation. `none`: no token is stored. `invalid`: the token sent is the one the push provider last rejected as unregistered for this installation; it was not stored, and the app must get a brand-new token and register again (D69).
@JsonEnum()
enum PushTokenStatus {
  @JsonValue('ok')
  ok('ok'),
  @JsonValue('none')
  none('none'),
  @JsonValue('invalid')
  invalid('invalid'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const PushTokenStatus(this.json);

  factory PushTokenStatus.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<PushTokenStatus> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
