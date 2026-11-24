// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'member_test_alert.g.dart';

@JsonSerializable()
class MemberTestAlert {
  const MemberTestAlert({
    required this.createdAt,
    required this.id,
    required this.isTest,
    required this.ownerName,
    required this.seenAt,
  });

  factory MemberTestAlert.fromJson(Map<String, Object?> json) =>
      _$MemberTestAlertFromJson(json);

  /// When the owner sent the test (UTC).
  @JsonKey(name: 'created_at')
  final String createdAt;
  final String id;

  /// Always true: a test, never an emergency.
  @JsonKey(name: 'is_test')
  final bool isTest;

  /// The circle owner current profile name (trimmed); null when blank.
  @JsonKey(name: 'owner_name')
  final String? ownerName;

  /// When the caller opened it; null until then.
  @JsonKey(name: 'seen_at')
  final String? seenAt;

  Map<String, Object?> toJson() => _$MemberTestAlertToJson(this);
}
