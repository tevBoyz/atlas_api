// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'activity_page.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ActivityPage _$ActivityPageFromJson(Map<String, dynamic> json) => ActivityPage(
  entries: (json['entries'] as List<dynamic>)
      .map((e) => ActivityEntry.fromJson(e as Map<String, dynamic>))
      .toList(),
  nextCursor: json['next_cursor'] as String?,
);

Map<String, dynamic> _$ActivityPageToJson(ActivityPage instance) =>
    <String, dynamic>{
      'entries': instance.entries,
      'next_cursor': instance.nextCursor,
    };
