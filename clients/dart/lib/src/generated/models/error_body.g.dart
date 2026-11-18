// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'error_body.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ErrorBody _$ErrorBodyFromJson(Map<String, dynamic> json) => ErrorBody(
  code: json['code'] as String,
  details: json['details'] as Map<String, dynamic>,
  message: json['message'] as String,
);

Map<String, dynamic> _$ErrorBodyToJson(ErrorBody instance) => <String, dynamic>{
  'code': instance.code,
  'details': instance.details,
  'message': instance.message,
};
