// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'test_alert_recipient.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

TestAlertRecipient _$TestAlertRecipientFromJson(Map<String, dynamic> json) =>
    TestAlertRecipient(
      deliveredAt: json['delivered_at'] as String?,
      displayName: json['display_name'] as String?,
      failureReason: json['failure_reason'] == null
          ? null
          : TestAlertFailureReason.fromJson(json['failure_reason'] as String),
      handle: json['handle'] as String?,
      seenAt: json['seen_at'] as String?,
      status: TestAlertMemberState.fromJson(json['status'] as String),
    );

Map<String, dynamic> _$TestAlertRecipientToJson(TestAlertRecipient instance) =>
    <String, dynamic>{
      'delivered_at': instance.deliveredAt,
      'display_name': instance.displayName,
      'failure_reason': instance.failureReason,
      'handle': instance.handle,
      'seen_at': instance.seenAt,
      'status': instance.status,
    };
