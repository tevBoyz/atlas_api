// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_info.dart';

part 'exchange_request.g.dart';

@JsonSerializable()
class ExchangeRequest {
  const ExchangeRequest({required this.device});

  factory ExchangeRequest.fromJson(Map<String, Object?> json) =>
      _$ExchangeRequestFromJson(json);

  final DeviceInfo device;

  Map<String, Object?> toJson() => _$ExchangeRequestToJson(this);
}
