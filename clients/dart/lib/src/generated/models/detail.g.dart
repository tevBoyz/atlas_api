// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'detail.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Detail _$DetailFromJson(Map<String, dynamic> json) => Detail(
  preset: json['preset'] == null
      ? null
      : Preset.fromJson(json['preset'] as String),
  reason: json['reason'] == null
      ? null
      : Reason.fromJson(json['reason'] as String),
  text: json['text'] as String?,
);

Map<String, dynamic> _$DetailToJson(Detail instance) => <String, dynamic>{
  'preset': instance.preset,
  'reason': instance.reason,
  'text': instance.text,
};
