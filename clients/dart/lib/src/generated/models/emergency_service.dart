// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'emergency_service_service.dart';

part 'emergency_service.g.dart';

@JsonSerializable()
class EmergencyService {
  const EmergencyService({
    required this.label,
    required this.number,
    required this.service,
  });

  factory EmergencyService.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$EmergencyServiceFromJson(json), json);

  /// What to show, e.g. `Ambulance`, `Fire and Rescue`.
  final String label;

  /// The number to dial, digits only (an optional leading `+`), e.g. `116`. Confirm before dialing.
  final String number;

  /// Which service. Clients show unknown future values as a plain number.
  final EmergencyServiceService service;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$EmergencyServiceToJson(this));
}
