// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'incoming_invite_status.dart';

part 'incoming_invite.g.dart';

@JsonSerializable()
class IncomingInvite {
  const IncomingInvite({
    required this.circleId,
    required this.inviteExpiresAt,
    required this.inviteToken,
    required this.invitedAt,
    required this.memberId,
    required this.ownerAvatarUrl,
    required this.ownerName,
    required this.status,
  });

  factory IncomingInvite.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$IncomingInviteFromJson(json), json);

  @JsonKey(name: 'circle_id')
  final String circleId;
  @JsonKey(name: 'invite_expires_at')
  final String? inviteExpiresAt;

  /// Only while `pending` (to accept or decline); null otherwise.
  @JsonKey(name: 'invite_token')
  final String? inviteToken;
  @JsonKey(name: 'invited_at')
  final String invitedAt;
  @JsonKey(name: 'member_id')
  final String memberId;

  /// SCRUM-33: the inviting circle owner's public avatar URL (the same rule as the preview's `owner_avatar_url`), or null when they have no photo.
  @JsonKey(name: 'owner_avatar_url')
  final String? ownerAvatarUrl;

  /// The owner row's stored display name.
  @JsonKey(name: 'owner_name')
  final String? ownerName;

  /// The lookup status (spec §5.3). Accepted (`consumed`) invitations are not listed.
  final IncomingInviteStatus status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$IncomingInviteToJson(this));
}
