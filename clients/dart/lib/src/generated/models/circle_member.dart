// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'circle_member_role.dart';
import 'circle_member_status.dart';

part 'circle_member.g.dart';

@JsonSerializable()
class CircleMember {
  const CircleMember({
    required this.avatarUrl,
    required this.displayName,
    required this.invitedAt,
    required this.isOwner,
    required this.memberId,
    required this.role,
    required this.status,
    required this.userId,
    this.email,
    this.inviteCanceledAt,
    this.inviteConsumedAt,
    this.inviteExpiresAt,
    this.phone,
    this.relationship,
  });

  factory CircleMember.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$CircleMemberFromJson(json), json);

  /// Public URL of the row user's profile photo (`{SUPABASE_URL}/storage/v1/object/public/avatars/{path}`); null without a user or photo.
  @JsonKey(name: 'avatar_url')
  final String? avatarUrl;

  /// Active rows with a user: that user's current profile name (trimmed), else the stored name. Other rows: the stored invite name.
  @JsonKey(name: 'display_name')
  final String displayName;

  /// Owner view only.
  final String? email;

  /// Owner view only.
  @JsonKey(name: 'invite_canceled_at')
  final String? inviteCanceledAt;

  /// Owner view only.
  @JsonKey(name: 'invite_consumed_at')
  final String? inviteConsumedAt;

  /// Owner view only.
  @JsonKey(name: 'invite_expires_at')
  final String? inviteExpiresAt;
  @JsonKey(name: 'invited_at')
  final String invitedAt;
  @JsonKey(name: 'is_owner')
  final bool isOwner;
  @JsonKey(name: 'member_id')
  final String memberId;

  /// Owner view only.
  final String? phone;

  /// Owner view only.
  final String? relationship;
  final CircleMemberRole role;
  final CircleMemberStatus status;
  @JsonKey(name: 'user_id')
  final String? userId;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$CircleMemberToJson(this));
}
