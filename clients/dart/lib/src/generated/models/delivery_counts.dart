// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'delivery_counts_status.dart';

part 'delivery_counts.g.dart';

@JsonSerializable()
class DeliveryCounts {
  const DeliveryCounts({
    required this.acknowledgedCount,
    required this.deliveredCount,
    required this.incidentId,
    required this.status,
  });

  factory DeliveryCounts.fromJson(Map<String, Object?> json) =>
      _$DeliveryCountsFromJson(json);

  @JsonKey(name: 'acknowledged_count')
  final int acknowledgedCount;
  @JsonKey(name: 'delivered_count')
  final int deliveredCount;
  @JsonKey(name: 'incident_id')
  final String incidentId;
  final DeliveryCountsStatus status;

  Map<String, Object?> toJson() => _$DeliveryCountsToJson(this);
}
