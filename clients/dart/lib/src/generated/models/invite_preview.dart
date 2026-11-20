// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'invite_preview_status.dart';

part 'invite_preview.g.dart';

@JsonSerializable()
class InvitePreview {
  const InvitePreview({
    required this.circleId,
    required this.claimed,
    required this.inviteExpiresAt,
    required this.invitedAt,
    required this.memberId,
    required this.ownerAvatarUrl,
    required this.ownerName,
    required this.recipientOk,
    required this.status,
  });

  factory InvitePreview.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$InvitePreviewFromJson(json), json);

  /// Only when the row is shown.
  @JsonKey(name: 'circle_id')
  final String? circleId;

  /// True when the invitation is (now) bound to the caller. Null where the SQL function returns null (e.g. the owner previewing an unclaimed invitation).
  final bool? claimed;
  @JsonKey(name: 'invite_expires_at')
  final String? inviteExpiresAt;

  /// Only when the row is shown.
  @JsonKey(name: 'invited_at')
  final String? invitedAt;

  /// Only when the row is shown.
  @JsonKey(name: 'member_id')
  final String? memberId;

  /// Only when the owner is shown: the owner's public avatar URL, or null.
  @JsonKey(name: 'owner_avatar_url')
  final String? ownerAvatarUrl;

  /// Only when the owner is shown: the owner row's stored display name.
  @JsonKey(name: 'owner_name')
  final String? ownerName;

  /// The caller may accept this invitation (spec rule 18).
  @JsonKey(name: 'recipient_ok')
  final bool recipientOk;

  /// Lookup status, or the display statuses `own_circle`, `already_member`, `circle_full`.
  final InvitePreviewStatus status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$InvitePreviewToJson(this));
}
