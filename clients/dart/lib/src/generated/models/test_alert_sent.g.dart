// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'test_alert_sent.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

TestAlertSent _$TestAlertSentFromJson(Map<String, dynamic> json) =>
    TestAlertSent(
      createdAt: json['created_at'] as String,
      id: json['id'] as String,
      recipientCount: (json['recipient_count'] as num).toInt(),
    );

Map<String, dynamic> _$TestAlertSentToJson(TestAlertSent instance) =>
    <String, dynamic>{
      'created_at': instance.createdAt,
      'id': instance.id,
      'recipient_count': instance.recipientCount,
    };
