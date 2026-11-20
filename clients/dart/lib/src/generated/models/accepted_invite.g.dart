// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'accepted_invite.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

AcceptedInvite _$AcceptedInviteFromJson(Map<String, dynamic> json) =>
    AcceptedInvite(
      circleId: json['circle_id'] as String,
      memberId: json['member_id'] as String,
      ownerName: json['owner_name'] as String?,
      status: json['status'] as String,
    );

Map<String, dynamic> _$AcceptedInviteToJson(AcceptedInvite instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'member_id': instance.memberId,
      'owner_name': instance.ownerName,
      'status': instance.status,
    };
