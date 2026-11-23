// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// responding / unable: the member's response; acknowledged: seen, no response yet; no_response: not acknowledged.
@JsonEnum()
enum ResponderStatus {
  @JsonValue('responding')
  responding('responding'),
  @JsonValue('acknowledged')
  acknowledged('acknowledged'),
  @JsonValue('unable')
  unable('unable'),
  @JsonValue('no_response')
  noResponse('no_response'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const ResponderStatus(this.json);

  factory ResponderStatus.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<ResponderStatus> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
