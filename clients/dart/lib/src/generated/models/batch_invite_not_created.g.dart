// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'batch_invite_not_created.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

BatchInviteNotCreated _$BatchInviteNotCreatedFromJson(
  Map<String, dynamic> json,
) => BatchInviteNotCreated(
  displayName: json['display_name'] as String?,
  phone: json['phone'] as String?,
  reason: BatchInviteNotCreatedReason.fromJson(json['reason'] as String),
);

Map<String, dynamic> _$BatchInviteNotCreatedToJson(
  BatchInviteNotCreated instance,
) => <String, dynamic>{
  'display_name': instance.displayName,
  'phone': instance.phone,
  'reason': instance.reason,
};
