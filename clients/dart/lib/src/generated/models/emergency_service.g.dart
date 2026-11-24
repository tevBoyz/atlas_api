// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'emergency_service.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EmergencyService _$EmergencyServiceFromJson(Map<String, dynamic> json) =>
    EmergencyService(
      label: json['label'] as String,
      number: json['number'] as String,
      service: EmergencyServiceService.fromJson(json['service'] as String),
    );

Map<String, dynamic> _$EmergencyServiceToJson(EmergencyService instance) =>
    <String, dynamic>{
      'label': instance.label,
      'number': instance.number,
      'service': instance.service,
    };
