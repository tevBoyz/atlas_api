// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'emergency_service.dart';

part 'emergency_numbers.g.dart';

@JsonSerializable()
class EmergencyNumbers {
  const EmergencyNumbers({
    required this.country,
    required this.emergencyServices,
  });

  factory EmergencyNumbers.fromJson(Map<String, Object?> json) =>
      _$EmergencyNumbersFromJson(json);

  /// ISO 3166-1 alpha-2 region the numbers are for (V1: `GM`).
  final String country;

  /// The local emergency numbers of the incident's region (SCRUM-54, D60), always in the order ambulance, police, fire_rescue; a service without a number is left out; `[]` when the region has none configured.
  @JsonKey(name: 'emergency_services')
  final List<EmergencyService> emergencyServices;

  Map<String, Object?> toJson() => _$EmergencyNumbersToJson(this);
}
