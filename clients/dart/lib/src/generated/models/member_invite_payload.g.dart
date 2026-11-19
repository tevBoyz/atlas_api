// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'member_invite_payload.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

MemberInvitePayload _$MemberInvitePayloadFromJson(Map<String, dynamic> json) =>
    MemberInvitePayload(
      circleId: json['circle_id'] as String,
      displayName: json['display_name'] as String,
      inviteExpiresAt: json['invite_expires_at'] as String?,
      inviteToken: json['invite_token'] as String,
      inviteUrl: json['invite_url'] as String,
      invitedAt: json['invited_at'] as String,
      memberId: json['member_id'] as String,
      phone: json['phone'] as String?,
      relationship: json['relationship'] as String?,
      resent: json['resent'] as bool,
      status: json['status'] as String,
    );

Map<String, dynamic> _$MemberInvitePayloadToJson(
  MemberInvitePayload instance,
) => <String, dynamic>{
  'circle_id': instance.circleId,
  'display_name': instance.displayName,
  'invite_expires_at': instance.inviteExpiresAt,
  'invite_token': instance.inviteToken,
  'invite_url': instance.inviteUrl,
  'invited_at': instance.invitedAt,
  'member_id': instance.memberId,
  'phone': instance.phone,
  'relationship': instance.relationship,
  'resent': instance.resent,
  'status': instance.status,
};
