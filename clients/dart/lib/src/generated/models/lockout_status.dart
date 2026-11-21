// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'lockout_status.g.dart';

@JsonSerializable()
class LockoutStatus {
  const LockoutStatus({
    required this.failedAttempts,
    required this.locked,
    required this.lockedUntil,
  });

  factory LockoutStatus.fromJson(Map<String, Object?> json) =>
      _$LockoutStatusFromJson(json);

  @JsonKey(name: 'failed_attempts')
  final int failedAttempts;
  final bool locked;

  /// Only when locked.
  @JsonKey(name: 'locked_until')
  final String? lockedUntil;

  Map<String, Object?> toJson() => _$LockoutStatusToJson(this);
}
