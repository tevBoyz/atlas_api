// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'test_alert_status.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

TestAlertStatus _$TestAlertStatusFromJson(Map<String, dynamic> json) =>
    TestAlertStatus(
      circleId: json['circle_id'] as String,
      createdAt: json['created_at'] as String,
      deliveredCount: (json['delivered_count'] as num).toInt(),
      failedCount: (json['failed_count'] as num).toInt(),
      id: json['id'] as String,
      pendingCount: (json['pending_count'] as num).toInt(),
      recipientCount: (json['recipient_count'] as num).toInt(),
      recipients: (json['recipients'] as List<dynamic>)
          .map((e) => TestAlertRecipient.fromJson(e as Map<String, dynamic>))
          .toList(),
      seenCount: (json['seen_count'] as num).toInt(),
    );

Map<String, dynamic> _$TestAlertStatusToJson(TestAlertStatus instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'created_at': instance.createdAt,
      'delivered_count': instance.deliveredCount,
      'failed_count': instance.failedCount,
      'id': instance.id,
      'pending_count': instance.pendingCount,
      'recipient_count': instance.recipientCount,
      'recipients': instance.recipients,
      'seen_count': instance.seenCount,
    };
