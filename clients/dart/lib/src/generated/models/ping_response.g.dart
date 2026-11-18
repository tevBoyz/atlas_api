// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'ping_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PingResponse _$PingResponseFromJson(Map<String, dynamic> json) => PingResponse(
  status: json['status'] as String,
  userId: json['user_id'] as String,
);

Map<String, dynamic> _$PingResponseToJson(PingResponse instance) =>
    <String, dynamic>{'status': instance.status, 'user_id': instance.userId};
