// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'incident_submit_result_emergency_type.dart';
import 'incident_submit_result_location_source.dart';
import 'incident_submit_result_status.dart';
import 'incident_submit_result_submit_outcome.dart';

part 'incident_submit_result.g.dart';

@JsonSerializable()
class IncidentSubmitResult {
  const IncidentSubmitResult({
    required this.acknowledgedCount,
    required this.activatedAt,
    required this.activityConfirmedAt,
    required this.autoClosed,
    required this.cancelledAt,
    required this.circleId,
    required this.deliveredCount,
    required this.emergencyType,
    required this.id,
    required this.incidentNotes,
    required this.incidentNotesUpdatedAt,
    required this.locationAccuracyM,
    required this.locationCapturedAt,
    required this.locationLat,
    required this.locationLng,
    required this.locationSharingEndedAt,
    required this.locationSource,
    required this.renotifiedAt,
    required this.residentId,
    required this.resolvedAt,
    required this.resolvedReason,
    required this.sentAt,
    required this.sharePayload,
    required this.status,
    required this.submitOutcome,
  });

  factory IncidentSubmitResult.fromJson(Map<String, Object?> json) =>
      _$IncidentSubmitResultFromJson(json);

  @JsonKey(name: 'acknowledged_count')
  final int acknowledgedCount;
  @JsonKey(name: 'activated_at')
  final String activatedAt;
  @JsonKey(name: 'activity_confirmed_at')
  final String? activityConfirmedAt;
  @JsonKey(name: 'auto_closed')
  final bool autoClosed;
  @JsonKey(name: 'cancelled_at')
  final String? cancelledAt;
  @JsonKey(name: 'circle_id')
  final String? circleId;
  @JsonKey(name: 'delivered_count')
  final int deliveredCount;
  @JsonKey(name: 'emergency_type')
  final IncidentSubmitResultEmergencyType emergencyType;
  final String id;
  @JsonKey(name: 'incident_notes')
  final String? incidentNotes;
  @JsonKey(name: 'incident_notes_updated_at')
  final String? incidentNotesUpdatedAt;
  @JsonKey(name: 'location_accuracy_m')
  final num? locationAccuracyM;
  @JsonKey(name: 'location_captured_at')
  final String? locationCapturedAt;
  @JsonKey(name: 'location_lat')
  final num? locationLat;
  @JsonKey(name: 'location_lng')
  final num? locationLng;
  @JsonKey(name: 'location_sharing_ended_at')
  final String? locationSharingEndedAt;
  @JsonKey(name: 'location_source')
  final IncidentSubmitResultLocationSource? locationSource;
  @JsonKey(name: 'renotified_at')
  final String? renotifiedAt;
  @JsonKey(name: 'resident_id')
  final String residentId;
  @JsonKey(name: 'resolved_at')
  final String? resolvedAt;
  @JsonKey(name: 'resolved_reason')
  final String? resolvedReason;
  @JsonKey(name: 'sent_at')
  final String? sentAt;
  @JsonKey(name: 'share_payload')
  final Map<String, String>? sharePayload;
  final IncidentSubmitResultStatus status;
  @JsonKey(name: 'submit_outcome')
  final IncidentSubmitResultSubmitOutcome submitOutcome;

  Map<String, Object?> toJson() => _$IncidentSubmitResultToJson(this);
}
