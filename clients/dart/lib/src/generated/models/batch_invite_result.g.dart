// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'batch_invite_result.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

BatchInviteResult _$BatchInviteResultFromJson(Map<String, dynamic> json) =>
    BatchInviteResult(
      availableAfter: (json['available_after'] as num).toInt(),
      created: (json['created'] as List<dynamic>)
          .map((e) => MemberInvitePayload.fromJson(e as Map<String, dynamic>))
          .toList(),
      notCreated: (json['not_created'] as List<dynamic>)
          .map((e) => BatchInviteNotCreated.fromJson(e as Map<String, dynamic>))
          .toList(),
      skipped: (json['skipped'] as List<dynamic>)
          .map((e) => BatchInviteSkipped.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$BatchInviteResultToJson(BatchInviteResult instance) =>
    <String, dynamic>{
      'available_after': instance.availableAfter,
      'created': instance.created,
      'not_created': instance.notCreated,
      'skipped': instance.skipped,
    };
