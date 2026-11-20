// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invite_preview.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

InvitePreview _$InvitePreviewFromJson(Map<String, dynamic> json) =>
    InvitePreview(
      circleId: json['circle_id'] as String?,
      claimed: json['claimed'] as bool?,
      inviteExpiresAt: json['invite_expires_at'] as String?,
      invitedAt: json['invited_at'] as String?,
      memberId: json['member_id'] as String?,
      ownerAvatarUrl: json['owner_avatar_url'] as String?,
      ownerName: json['owner_name'] as String?,
      recipientOk: json['recipient_ok'] as bool,
      status: InvitePreviewStatus.fromJson(json['status'] as String),
    );

Map<String, dynamic> _$InvitePreviewToJson(InvitePreview instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'claimed': instance.claimed,
      'invite_expires_at': instance.inviteExpiresAt,
      'invited_at': instance.invitedAt,
      'member_id': instance.memberId,
      'owner_avatar_url': instance.ownerAvatarUrl,
      'owner_name': instance.ownerName,
      'recipient_ok': instance.recipientOk,
      'status': instance.status,
    };
