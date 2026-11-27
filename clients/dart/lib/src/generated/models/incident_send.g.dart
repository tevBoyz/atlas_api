// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'incident_send.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

IncidentSend _$IncidentSendFromJson(Map<String, dynamic> json) => IncidentSend(
  acknowledgedCount: (json['acknowledged_count'] as num).toInt(),
  activatedAt: json['activated_at'] as String,
  activityConfirmedAt: json['activity_confirmed_at'] as String?,
  autoClosed: json['auto_closed'] as bool,
  cancelledAt: json['cancelled_at'] as String?,
  circleId: json['circle_id'] as String?,
  countryCode: json['country_code'] as String?,
  deliveredCount: (json['delivered_count'] as num).toInt(),
  emergencyType: IncidentSendEmergencyType.fromJson(
    json['emergency_type'] as String,
  ),
  id: json['id'] as String,
  incidentNotes: json['incident_notes'] as String?,
  incidentNotesUpdatedAt: json['incident_notes_updated_at'] as String?,
  locationAccuracyM: json['location_accuracy_m'] as num?,
  locationCapturedAt: json['location_captured_at'] as String?,
  locationLat: json['location_lat'] as num?,
  locationLng: json['location_lng'] as num?,
  locationSharingEndedAt: json['location_sharing_ended_at'] as String?,
  locationSource: json['location_source'] == null
      ? null
      : IncidentSendLocationSource.fromJson(json['location_source'] as String),
  locationUnavailableSince: json['location_unavailable_since'] as String?,
  placeName: json['place_name'] as String?,
  renotifiedAt: json['renotified_at'] as String?,
  residentId: json['resident_id'] as String,
  resolvedAt: json['resolved_at'] as String?,
  resolvedReason: json['resolved_reason'] as String?,
  sentAt: json['sent_at'] as String?,
  sharePayload: json['share_payload'] as Map<String, dynamic>?,
  status: IncidentSendStatus.fromJson(json['status'] as String),
);

Map<String, dynamic> _$IncidentSendToJson(IncidentSend instance) =>
    <String, dynamic>{
      'acknowledged_count': instance.acknowledgedCount,
      'activated_at': instance.activatedAt,
      'activity_confirmed_at': instance.activityConfirmedAt,
      'auto_closed': instance.autoClosed,
      'cancelled_at': instance.cancelledAt,
      'circle_id': instance.circleId,
      'country_code': instance.countryCode,
      'delivered_count': instance.deliveredCount,
      'emergency_type': instance.emergencyType,
      'id': instance.id,
      'incident_notes': instance.incidentNotes,
      'incident_notes_updated_at': instance.incidentNotesUpdatedAt,
      'location_accuracy_m': instance.locationAccuracyM,
      'location_captured_at': instance.locationCapturedAt,
      'location_lat': instance.locationLat,
      'location_lng': instance.locationLng,
      'location_sharing_ended_at': instance.locationSharingEndedAt,
      'location_source': instance.locationSource,
      'location_unavailable_since': instance.locationUnavailableSince,
      'place_name': instance.placeName,
      'renotified_at': instance.renotifiedAt,
      'resident_id': instance.residentId,
      'resolved_at': instance.resolvedAt,
      'resolved_reason': instance.resolvedReason,
      'sent_at': instance.sentAt,
      'share_payload': instance.sharePayload,
      'status': instance.status,
    };
