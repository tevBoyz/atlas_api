// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'delivery_counts.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DeliveryCounts _$DeliveryCountsFromJson(Map<String, dynamic> json) =>
    DeliveryCounts(
      acknowledgedCount: (json['acknowledged_count'] as num).toInt(),
      deliveredCount: (json['delivered_count'] as num).toInt(),
      incidentId: json['incident_id'] as String,
      status: DeliveryCountsStatus.fromJson(json['status'] as String),
    );

Map<String, dynamic> _$DeliveryCountsToJson(DeliveryCounts instance) =>
    <String, dynamic>{
      'acknowledged_count': instance.acknowledgedCount,
      'delivered_count': instance.deliveredCount,
      'incident_id': instance.incidentId,
      'status': instance.status,
    };
