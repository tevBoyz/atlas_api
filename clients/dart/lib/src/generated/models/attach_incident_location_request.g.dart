// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'attach_incident_location_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

AttachIncidentLocationRequest _$AttachIncidentLocationRequestFromJson(
  Map<String, dynamic> json,
) => AttachIncidentLocationRequest(
  locationSource: AttachIncidentLocationRequestLocationSource.fromJson(
    json['location_source'] as String,
  ),
  locationAccuracyM: json['location_accuracy_m'] as num?,
  locationCapturedAt: json['location_captured_at'] as String?,
  locationLat: json['location_lat'] as num?,
  locationLng: json['location_lng'] as num?,
);

Map<String, dynamic> _$AttachIncidentLocationRequestToJson(
  AttachIncidentLocationRequest instance,
) => <String, dynamic>{
  'location_accuracy_m': instance.locationAccuracyM,
  'location_captured_at': instance.locationCapturedAt,
  'location_lat': instance.locationLat,
  'location_lng': instance.locationLng,
  'location_source': instance.locationSource,
};
