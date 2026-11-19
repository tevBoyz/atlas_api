// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'capacity.g.dart';

@JsonSerializable()
class Capacity {
  const Capacity({
    required this.activeCount,
    required this.available,
    required this.limit,
    required this.pendingCount,
    required this.used,
  });

  factory Capacity.fromJson(Map<String, Object?> json) =>
      _$CapacityFromJson(json);

  /// Active members, owner excluded.
  @JsonKey(name: 'active_count')
  final int activeCount;

  /// `max(0, limit - used)`.
  final int available;

  /// Trusted-member slots, owner excluded (5).
  final int limit;

  /// Valid pending invites only: not canceled, not consumed, not expired.
  @JsonKey(name: 'pending_count')
  final int pendingCount;

  /// `active_count + pending_count`.
  final int used;

  Map<String, Object?> toJson() => _$CapacityToJson(this);
}
