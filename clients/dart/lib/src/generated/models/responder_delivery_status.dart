// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// RESIDENT ONLY (SCRUM-65, D73; absent on a member's rows): the alert's delivery to this member. delivered = the push service accepted the alert (or a re-notify) for at least one of their devices; sent = still being sent or retried; failed = every attempt failed after its retries, or nothing could be sent (no device with notifications, push switched off). A re-notify recomputes it (failed can become delivered).
@JsonEnum()
enum ResponderDeliveryStatus {
  @JsonValue('sent')
  sent('sent'),
  @JsonValue('delivered')
  delivered('delivered'),
  @JsonValue('failed')
  failed('failed'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const ResponderDeliveryStatus(this.json);

  factory ResponderDeliveryStatus.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<ResponderDeliveryStatus> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
