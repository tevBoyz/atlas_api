// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'incoming_invite.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

IncomingInvite _$IncomingInviteFromJson(Map<String, dynamic> json) =>
    IncomingInvite(
      circleId: json['circle_id'] as String,
      inviteExpiresAt: json['invite_expires_at'] as String?,
      inviteToken: json['invite_token'] as String?,
      invitedAt: json['invited_at'] as String,
      memberId: json['member_id'] as String,
      ownerAvatarUrl: json['owner_avatar_url'] as String?,
      ownerName: json['owner_name'] as String?,
      status: IncomingInviteStatus.fromJson(json['status'] as String),
    );

Map<String, dynamic> _$IncomingInviteToJson(IncomingInvite instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'invite_expires_at': instance.inviteExpiresAt,
      'invite_token': instance.inviteToken,
      'invited_at': instance.invitedAt,
      'member_id': instance.memberId,
      'owner_avatar_url': instance.ownerAvatarUrl,
      'owner_name': instance.ownerName,
      'status': instance.status,
    };
