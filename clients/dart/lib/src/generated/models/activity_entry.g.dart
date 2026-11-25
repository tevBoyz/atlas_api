// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'activity_entry.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ActivityEntry _$ActivityEntryFromJson(Map<String, dynamic> json) =>
    ActivityEntry(
      actorName: json['actor_name'] as String?,
      category: ActivityEntryCategory.fromJson(json['category'] as String),
      detail: json['detail'] == null
          ? null
          : Detail.fromJson(json['detail'] as Map<String, dynamic>),
      id: json['id'] as String,
      incident: ActivityIncident.fromJson(
        json['incident'] as Map<String, dynamic>,
      ),
      kind: ActivityEntryKind.fromJson(json['kind'] as String),
      occurredAt: json['occurred_at'] as String,
    );

Map<String, dynamic> _$ActivityEntryToJson(ActivityEntry instance) =>
    <String, dynamic>{
      'actor_name': instance.actorName,
      'category': instance.category,
      'detail': instance.detail,
      'id': instance.id,
      'incident': instance.incident,
      'kind': instance.kind,
      'occurred_at': instance.occurredAt,
    };
