// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'circle_member.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

CircleMember _$CircleMemberFromJson(Map<String, dynamic> json) => CircleMember(
  avatarUrl: json['avatar_url'] as String?,
  displayName: json['display_name'] as String,
  handle: json['handle'] as String,
  invitedAt: json['invited_at'] as String,
  isOwner: json['is_owner'] as bool,
  memberId: json['member_id'] as String,
  role: CircleMemberRole.fromJson(json['role'] as String),
  status: CircleMemberStatus.fromJson(json['status'] as String),
  userId: json['user_id'] as String?,
  email: json['email'] as String?,
  inviteCanceledAt: json['invite_canceled_at'] as String?,
  inviteConsumedAt: json['invite_consumed_at'] as String?,
  inviteExpiresAt: json['invite_expires_at'] as String?,
  phone: json['phone'] as String?,
  relationship: json['relationship'] as String?,
);

Map<String, dynamic> _$CircleMemberToJson(CircleMember instance) =>
    <String, dynamic>{
      'avatar_url': instance.avatarUrl,
      'display_name': instance.displayName,
      'email': instance.email,
      'handle': instance.handle,
      'invite_canceled_at': instance.inviteCanceledAt,
      'invite_consumed_at': instance.inviteConsumedAt,
      'invite_expires_at': instance.inviteExpiresAt,
      'invited_at': instance.invitedAt,
      'is_owner': instance.isOwner,
      'member_id': instance.memberId,
      'phone': instance.phone,
      'relationship': instance.relationship,
      'role': instance.role,
      'status': instance.status,
      'user_id': instance.userId,
    };
