// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum DeliveryCountsStatus {
  @JsonValue('active')
  active('active'),
  @JsonValue('resolved')
  resolved('resolved'),
  @JsonValue('activating')
  activating('activating'),
  @JsonValue('cancelled')
  cancelled('cancelled'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const DeliveryCountsStatus(this.json);

  factory DeliveryCountsStatus.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<DeliveryCountsStatus> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
