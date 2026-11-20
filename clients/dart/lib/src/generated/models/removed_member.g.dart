// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'removed_member.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

RemovedMember _$RemovedMemberFromJson(Map<String, dynamic> json) =>
    RemovedMember(
      circleId: json['circle_id'] as String,
      memberId: json['member_id'] as String,
      removed: json['removed'] as bool,
    );

Map<String, dynamic> _$RemovedMemberToJson(RemovedMember instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'member_id': instance.memberId,
      'removed': instance.removed,
    };
