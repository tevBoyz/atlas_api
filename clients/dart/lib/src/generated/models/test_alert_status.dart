// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'test_alert_recipient.dart';

part 'test_alert_status.g.dart';

@JsonSerializable()
class TestAlertStatus {
  const TestAlertStatus({
    required this.circleId,
    required this.createdAt,
    required this.deliveredCount,
    required this.failedCount,
    required this.id,
    required this.pendingCount,
    required this.recipientCount,
    required this.recipients,
    required this.seenCount,
  });

  factory TestAlertStatus.fromJson(Map<String, Object?> json) =>
      _$TestAlertStatusFromJson(json);

  @JsonKey(name: 'circle_id')
  final String circleId;
  @JsonKey(name: 'created_at')
  final String createdAt;

  /// Members whose push the provider accepted.
  @JsonKey(name: 'delivered_count')
  final int deliveredCount;
  @JsonKey(name: 'failed_count')
  final int failedCount;
  final String id;

  /// Per member, exclusive: the four counts add up to `recipient_count`.
  @JsonKey(name: 'pending_count')
  final int pendingCount;
  @JsonKey(name: 'recipient_count')
  final int recipientCount;

  /// Every recipient, by name. `status`: `pending` (not sent yet or being retried), `delivered` (the push provider accepted it), `seen` (the member opened it in Atlas), `failed` (see `failure_reason`).
  final List<TestAlertRecipient> recipients;

  /// Members who opened it in Atlas.
  @JsonKey(name: 'seen_count')
  final int seenCount;

  Map<String, Object?> toJson() => _$TestAlertStatusToJson(this);
}
