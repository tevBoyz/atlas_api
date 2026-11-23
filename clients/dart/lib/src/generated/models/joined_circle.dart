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
    required this.activeIncidentId,
    required this.activeMemberCount,
    required this.capacityUsed,
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

  /// SCRUM-81: the newest active incident of this circle that the caller may open, else null. On a `member` row: an alert the caller received (started after they joined, while still a member); on the own `owner` row: the caller's own active alert (they are its resident). A member opens it with `GET /v1/incidents/{id}`; the owner with `GET /v1/me/incidents/open`.
  @JsonKey(name: 'active_incident_id')
  final String? activeIncidentId;

  /// Active members of the circle, owner excluded (pending and declined excluded).
  @JsonKey(name: 'active_member_count')
  final int activeMemberCount;

  /// Gap 20 (D50): slots used in this circle, owner excluded: active members + valid pending invitations (not canceled, not consumed, not expired); the same number as Capacity `used` on the owner screen. For "Members (n of 5)" in the Member View. A count only.
  @JsonKey(name: 'capacity_used')
  final int capacityUsed;
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
