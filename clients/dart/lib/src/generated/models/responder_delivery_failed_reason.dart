// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// RESIDENT ONLY (D73): failed = the push service did not accept it after the retries; no_device = nothing could be sent (no device with notifications or push switched off); null unless delivery_status is failed.
@JsonEnum()
enum ResponderDeliveryFailedReason {
  @JsonValue('no_device')
  noDevice('no_device'),
  @JsonValue('failed')
  failed('failed'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const ResponderDeliveryFailedReason(this.json);

  factory ResponderDeliveryFailedReason.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<ResponderDeliveryFailedReason> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
