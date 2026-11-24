// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'member_test_alert.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

MemberTestAlert _$MemberTestAlertFromJson(Map<String, dynamic> json) =>
    MemberTestAlert(
      createdAt: json['created_at'] as String,
      id: json['id'] as String,
      isTest: json['is_test'] as bool,
      ownerName: json['owner_name'] as String?,
      seenAt: json['seen_at'] as String?,
    );

Map<String, dynamic> _$MemberTestAlertToJson(MemberTestAlert instance) =>
    <String, dynamic>{
      'created_at': instance.createdAt,
      'id': instance.id,
      'is_test': instance.isTest,
      'owner_name': instance.ownerName,
      'seen_at': instance.seenAt,
    };
