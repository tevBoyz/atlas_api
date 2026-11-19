// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'attach_incident_location_request_location_source.dart';

part 'attach_incident_location_request.g.dart';

@JsonSerializable()
class AttachIncidentLocationRequest {
  const AttachIncidentLocationRequest({
    required this.locationSource,
    this.locationAccuracyM,
    this.locationCapturedAt,
    this.locationLat,
    this.locationLng,
  });

  factory AttachIncidentLocationRequest.fromJson(Map<String, Object?> json) =>
      _$AttachIncidentLocationRequestFromJson(json);

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

  Map<String, Object?> toJson() => _$AttachIncidentLocationRequestToJson(this);
}
