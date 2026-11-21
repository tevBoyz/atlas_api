// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'exchange_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ExchangeRequest _$ExchangeRequestFromJson(Map<String, dynamic> json) =>
    ExchangeRequest(
      device: DeviceInfo.fromJson(json['device'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$ExchangeRequestToJson(ExchangeRequest instance) =>
    <String, dynamic>{'device': instance.device};
