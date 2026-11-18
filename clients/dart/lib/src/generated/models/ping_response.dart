// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'ping_response.g.dart';

@JsonSerializable()
class PingResponse {
  const PingResponse({required this.status, required this.userId});

  factory PingResponse.fromJson(Map<String, Object?> json) =>
      _$PingResponseFromJson(json);

  final String status;
  @JsonKey(name: 'user_id')
  final String userId;

  Map<String, Object?> toJson() => _$PingResponseToJson(this);
}
