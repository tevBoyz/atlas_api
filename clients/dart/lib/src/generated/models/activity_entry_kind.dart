// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// emergency_initiated (own alert sent; Sent), alert_received (a circle alert reached the caller; Received), location_shared (own alert, live location started; Active), acknowledged / responding / unable (a member acknowledged or set their response: on own alerts any member, on circle alerts the caller only), status_update (circle alerts: an update from the resident; detail.preset or detail.text), ended (once per alert: marked safe, or closed automatically; detail.reason).
@JsonEnum()
enum ActivityEntryKind {
  @JsonValue('emergency_initiated')
  emergencyInitiated('emergency_initiated'),
  @JsonValue('alert_received')
  alertReceived('alert_received'),
  @JsonValue('location_shared')
  locationShared('location_shared'),
  @JsonValue('acknowledged')
  acknowledged('acknowledged'),
  @JsonValue('responding')
  responding('responding'),
  @JsonValue('unable')
  unable('unable'),
  @JsonValue('status_update')
  statusUpdate('status_update'),
  @JsonValue('ended')
  ended('ended'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const ActivityEntryKind(this.json);

  factory ActivityEntryKind.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<ActivityEntryKind> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
