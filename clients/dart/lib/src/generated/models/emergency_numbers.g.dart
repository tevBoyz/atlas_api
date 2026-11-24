// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'emergency_numbers.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EmergencyNumbers _$EmergencyNumbersFromJson(Map<String, dynamic> json) =>
    EmergencyNumbers(
      country: json['country'] as String,
      emergencyServices: (json['emergency_services'] as List<dynamic>)
          .map((e) => EmergencyService.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$EmergencyNumbersToJson(EmergencyNumbers instance) =>
    <String, dynamic>{
      'country': instance.country,
      'emergency_services': instance.emergencyServices,
    };
