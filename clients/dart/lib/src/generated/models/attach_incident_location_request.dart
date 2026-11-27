// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'attach_incident_location_request_location_source.dart';

part 'attach_incident_location_request.g.dart';

@JsonSerializable()
class AttachIncidentLocationRequest {
  const AttachIncidentLocationRequest({
    required this.locationSource,
    this.countryCode,
    this.locationAccuracyM,
    this.locationCapturedAt,
    this.locationLat,
    this.locationLng,
    this.placeName,
  });

  factory AttachIncidentLocationRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$AttachIncidentLocationRequestFromJson(json), json);

  /// Stage 2 [B9]: ISO 3166-1 alpha-2 country of that place (e.g. `GM`; stored uppercase). Chooses the incident's `emergency_services`. Left out keeps the stored country; a value that is not two letters is ignored.
  @JsonKey(name: 'country_code')
  final String? countryCode;

  /// Metres. Required for `current`.
  @JsonKey(name: 'location_accuracy_m')
  final num? locationAccuracyM;

  /// Device fix time, ISO-8601 with an offset (a time without one is read as UTC). A fix older than the stored one is ignored.
  @JsonKey(name: 'location_captured_at')
  final String? locationCapturedAt;
  @JsonKey(name: 'location_lat')
  final num? locationLat;
  @JsonKey(name: 'location_lng')
  final num? locationLng;
  @JsonKey(name: 'location_source')
  final AttachIncidentLocationRequestLocationSource locationSource;

  /// Stage 2 [B6]: the place reverse-geocoded on the phone from the current or last known fix (e.g. `Serrekunda`); trimmed, 1-120 characters. The alert push says "near <place_name>". Left out keeps the stored place; a value that is not valid is ignored (never an error).
  @JsonKey(name: 'place_name')
  final String? placeName;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$AttachIncidentLocationRequestToJson(this));
}
