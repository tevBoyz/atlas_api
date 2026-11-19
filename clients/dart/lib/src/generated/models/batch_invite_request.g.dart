// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'batch_invite_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

BatchInviteRequest _$BatchInviteRequestFromJson(Map<String, dynamic> json) =>
    BatchInviteRequest(
      invites: (json['invites'] as List<dynamic>)
          .map((e) => BatchInviteItem.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$BatchInviteRequestToJson(BatchInviteRequest instance) =>
    <String, dynamic>{'invites': instance.invites};
