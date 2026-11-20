// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'profile_setup_result_member_status.dart';

part 'profile_setup_result.g.dart';

@JsonSerializable()
class ProfileSetupResult {
  const ProfileSetupResult({
    required this.circleId,
    required this.locationSharingEnabled,
    required this.memberId,
    required this.memberStatus,
    required this.profileSetupCompletedAt,
  });

  factory ProfileSetupResult.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$ProfileSetupResultFromJson(json), json);

  /// Null while location sharing is off (no circle yet).
  @JsonKey(name: 'circle_id')
  final String? circleId;
  @JsonKey(name: 'location_sharing_enabled')
  final bool locationSharingEnabled;

  /// The emergency contact's member row.
  @JsonKey(name: 'member_id')
  final String? memberId;

  /// The contact row's stored status: `declined` when it was left unchanged because the circle is full.
  @JsonKey(name: 'member_status')
  final ProfileSetupResultMemberStatus? memberStatus;

  /// First completion time; never moves.
  @JsonKey(name: 'profile_setup_completed_at')
  final String profileSetupCompletedAt;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$ProfileSetupResultToJson(this));
}
