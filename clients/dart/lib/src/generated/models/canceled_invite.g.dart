// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'canceled_invite.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

CanceledInvite _$CanceledInviteFromJson(Map<String, dynamic> json) =>
    CanceledInvite(
      circleId: json['circle_id'] as String,
      memberId: json['member_id'] as String,
      ownerName: json['owner_name'] as String?,
      status: json['status'] as String,
    );

Map<String, dynamic> _$CanceledInviteToJson(CanceledInvite instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'member_id': instance.memberId,
      'owner_name': instance.ownerName,
      'status': instance.status,
    };
