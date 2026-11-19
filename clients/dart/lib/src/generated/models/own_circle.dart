// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'capacity.dart';
import 'circle_member.dart';
import 'safety_circle.dart';

part 'own_circle.g.dart';

@JsonSerializable()
class OwnCircle {
  const OwnCircle({
    required this.capacity,
    required this.circle,
    required this.members,
  });

  factory OwnCircle.fromJson(Map<String, Object?> json) =>
      _$OwnCircleFromJson(json);

  /// Null when the caller owns no circle.
  final Capacity? capacity;

  /// Null when the caller owns no circle.
  final SafetyCircle? circle;

  /// Owner view of the member list (owner row first); empty when there is no circle.
  final List<CircleMember> members;

  Map<String, Object?> toJson() => _$OwnCircleToJson(this);
}
