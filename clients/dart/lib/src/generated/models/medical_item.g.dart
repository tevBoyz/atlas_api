// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'medical_item.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

MedicalItem _$MedicalItemFromJson(Map<String, dynamic> json) => MedicalItem(
  id: json['id'] as String,
  text: json['text'] as String,
  updatedAt: json['updated_at'] as String,
);

Map<String, dynamic> _$MedicalItemToJson(MedicalItem instance) =>
    <String, dynamic>{
      'id': instance.id,
      'text': instance.text,
      'updated_at': instance.updatedAt,
    };
