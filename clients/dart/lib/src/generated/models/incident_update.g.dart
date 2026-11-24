// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'incident_update.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

IncidentUpdate _$IncidentUpdateFromJson(Map<String, dynamic> json) =>
    IncidentUpdate(
      createdAt: json['created_at'] as String,
      id: json['id'] as String,
      preset: json['preset'] == null
          ? null
          : IncidentUpdatePreset.fromJson(json['preset'] as String),
      text: json['text'] as String?,
    );

Map<String, dynamic> _$IncidentUpdateToJson(IncidentUpdate instance) =>
    <String, dynamic>{
      'created_at': instance.createdAt,
      'id': instance.id,
      'preset': instance.preset,
      'text': instance.text,
    };
