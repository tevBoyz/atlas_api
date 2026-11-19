// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'batch_invite_skipped.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

BatchInviteSkipped _$BatchInviteSkippedFromJson(Map<String, dynamic> json) =>
    BatchInviteSkipped(
      displayName: json['display_name'] as String,
      memberId: json['member_id'] as String,
      phone: json['phone'] as String,
      reason: BatchInviteSkippedReason.fromJson(json['reason'] as String),
    );

Map<String, dynamic> _$BatchInviteSkippedToJson(BatchInviteSkipped instance) =>
    <String, dynamic>{
      'display_name': instance.displayName,
      'member_id': instance.memberId,
      'phone': instance.phone,
      'reason': instance.reason,
    };
