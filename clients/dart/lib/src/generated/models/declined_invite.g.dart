// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'declined_invite.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DeclinedInvite _$DeclinedInviteFromJson(Map<String, dynamic> json) =>
    DeclinedInvite(
      circleId: json['circle_id'] as String,
      memberId: json['member_id'] as String,
      ownerName: json['owner_name'] as String?,
      status: json['status'] as String,
    );

Map<String, dynamic> _$DeclinedInviteToJson(DeclinedInvite instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'member_id': instance.memberId,
      'owner_name': instance.ownerName,
      'status': instance.status,
    };
