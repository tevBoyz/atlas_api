// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'incident_details.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

IncidentDetails _$IncidentDetailsFromJson(Map<String, dynamic> json) =>
    IncidentDetails(
      activatedAt: json['activated_at'] as String,
      autoClosed: json['auto_closed'] as bool,
      emergencyServices: (json['emergency_services'] as List<dynamic>)
          .map((e) => EmergencyService.fromJson(e as Map<String, dynamic>))
          .toList(),
      emergencyType: IncidentDetailsEmergencyType.fromJson(
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
          : IncidentDetailsLocationSource.fromJson(
              json['location_source'] as String,
            ),
      renotifiedAt: json['renotified_at'] as String?,
      residentName: json['resident_name'] as String,
      resolvedAt: json['resolved_at'] as String?,
      resolvedReason: json['resolved_reason'] as String?,
      sentAt: json['sent_at'] as String?,
      sharePayload: json['share_payload'] as Map<String, dynamic>,
      sharePayloadAtActivation:
          json['share_payload_at_activation'] as Map<String, dynamic>,
      sharePayloadUpdatedAt: json['share_payload_updated_at'] as String?,
      status: IncidentDetailsStatus.fromJson(json['status'] as String),
    );

Map<String, dynamic> _$IncidentDetailsToJson(IncidentDetails instance) =>
    <String, dynamic>{
      'activated_at': instance.activatedAt,
      'auto_closed': instance.autoClosed,
      'emergency_services': instance.emergencyServices,
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
      'renotified_at': instance.renotifiedAt,
      'resident_name': instance.residentName,
      'resolved_at': instance.resolvedAt,
      'resolved_reason': instance.resolvedReason,
      'sent_at': instance.sentAt,
      'share_payload': instance.sharePayload,
      'share_payload_at_activation': instance.sharePayloadAtActivation,
      'share_payload_updated_at': instance.sharePayloadUpdatedAt,
      'status': instance.status,
    };
