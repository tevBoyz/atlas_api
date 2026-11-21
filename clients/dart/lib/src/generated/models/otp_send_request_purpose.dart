// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// `sign_in` (no access token) or `verify_phone` (the signed-in user's own number; send the access token).
@JsonEnum()
enum OtpSendRequestPurpose {
  @JsonValue('verify_phone')
  verifyPhone('verify_phone'),
  @JsonValue('sign_in')
  signIn('sign_in'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const OtpSendRequestPurpose(this.json);

  factory OtpSendRequestPurpose.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<OtpSendRequestPurpose> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
