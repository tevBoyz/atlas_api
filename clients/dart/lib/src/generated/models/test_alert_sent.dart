// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'test_alert_sent.g.dart';

@JsonSerializable()
class TestAlertSent {
  const TestAlertSent({
    required this.createdAt,
    required this.id,
    required this.recipientCount,
  });

  factory TestAlertSent.fromJson(Map<String, Object?> json) =>
      _$TestAlertSentFromJson(json);

  /// When the test was sent (UTC).
  @JsonKey(name: 'created_at')
  final String createdAt;
  final String id;

  /// How many active members it was sent to (pending members are never included).
  @JsonKey(name: 'recipient_count')
  final int recipientCount;

  Map<String, Object?> toJson() => _$TestAlertSentToJson(this);
}
