// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'joined_circle_role.dart';

part 'joined_circle.g.dart';

@JsonSerializable()
class JoinedCircle {
  const JoinedCircle({
    required this.activeMemberCount,
    required this.circleId,
    required this.joinedAt,
    required this.memberId,
    required this.name,
    required this.ownerName,
    required this.role,
    required this.status,
  });

  factory JoinedCircle.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$JoinedCircleFromJson(json), json);

  /// Active members of the circle, owner excluded (pending and declined excluded).
  @JsonKey(name: 'active_member_count')
  final int activeMemberCount;
  @JsonKey(name: 'circle_id')
  final String circleId;

  /// The caller's member row `updated_at`.
  @JsonKey(name: 'joined_at')
  final String joinedAt;

  /// The caller's member row in that circle.
  @JsonKey(name: 'member_id')
  final String memberId;
  final String name;

  /// The owner row's stored display name.
  @JsonKey(name: 'owner_name')
  final String? ownerName;

  /// `owner` for the circle the caller owns (it is listed too, as today).
  final JoinedCircleRole role;
  final String status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$JoinedCircleToJson(this));
}
