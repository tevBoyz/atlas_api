// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'member_invite_payload.g.dart';

@JsonSerializable()
class MemberInvitePayload {
  const MemberInvitePayload({
    required this.circleId,
    required this.displayName,
    required this.inviteExpiresAt,
    required this.inviteToken,
    required this.inviteUrl,
    required this.invitedAt,
    required this.memberId,
    required this.phone,
    required this.relationship,
    required this.resent,
    required this.status,
  });

  factory MemberInvitePayload.fromJson(Map<String, Object?> json) =>
      _$MemberInvitePayloadFromJson(json);

  @JsonKey(name: 'circle_id')
  final String circleId;
  @JsonKey(name: 'display_name')
  final String displayName;
  @JsonKey(name: 'invite_expires_at')
  final String? inviteExpiresAt;

  /// 64 lowercase hex characters; single use; 7-day expiry.
  @JsonKey(name: 'invite_token')
  final String inviteToken;

  /// `INVITE_URL_BASE` + `invite_token`.
  @JsonKey(name: 'invite_url')
  final String inviteUrl;
  @JsonKey(name: 'invited_at')
  final String invitedAt;
  @JsonKey(name: 'member_id')
  final String memberId;

  /// Null for a link invite.
  final String? phone;
  final String? relationship;

  /// True when an existing row was refreshed (same `member_id`).
  final bool resent;

  /// Stored status of the row: `pending`.
  final String status;

  Map<String, Object?> toJson() => _$MemberInvitePayloadToJson(this);
}
