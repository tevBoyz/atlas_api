// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invite_lookup.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

InviteLookup _$InviteLookupFromJson(Map<String, dynamic> json) => InviteLookup(
  inviteExpiresAt: json['invite_expires_at'] as String?,
  status: InviteLookupStatus.fromJson(json['status'] as String),
);

Map<String, dynamic> _$InviteLookupToJson(InviteLookup instance) =>
    <String, dynamic>{
      'invite_expires_at': instance.inviteExpiresAt,
      'status': instance.status,
    };
