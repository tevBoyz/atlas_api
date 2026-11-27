// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'emergency_service.dart';
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
    required this.closedAt,
    required this.countryCode,
    required this.deliveredCount,
    required this.emergencyServices,
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
    required this.locationUnavailableSince,
    required this.placeName,
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
      keepRawJson(_$IncidentSubmitResultFromJson(json), json);

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

  /// SCRUM-63 (D61): when the incident became Closed; always null on the live bodies (only an active incident is open, re-notified or submitted; resolved and closed incidents never block a new SOS).
  @JsonKey(name: 'closed_at')
  final String? closedAt;

  /// Stage 2 [B9]: ISO 3166-1 alpha-2 country of the alert (uppercase); null = not known. `emergency_services` are those of this country, else The Gambia.
  @JsonKey(name: 'country_code')
  final String? countryCode;
  @JsonKey(name: 'delivered_count')
  final int deliveredCount;

  /// The local emergency numbers of the incident's region (SCRUM-54, D60), always in the order ambulance, police, fire_rescue; a service without a number is left out; `[]` when the region has none configured.
  @JsonKey(name: 'emergency_services')
  final List<EmergencyService> emergencyServices;
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

  /// SCRUM-68 (D74): since when the phone of the resident reports live location unavailable; null = live location is not reported unavailable. The location keys keep the last known fix (location_captured_at = when it was taken), so show it labelled "Last known · N min ago" with "Location unavailable". With no fix ever stored, location_source is unavailable and the position keys are null. The next fix clears it.
  @JsonKey(name: 'location_unavailable_since')
  final String? locationUnavailableSince;

  /// Stage 2 [B6]: the reverse-geocoded place of the alert (the latest the resident's phone sent); null = not known. Never coordinates.
  @JsonKey(name: 'place_name')
  final String? placeName;
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

  /// Shared fields by key. Values are strings, except `allergies` / `medical_conditions`: arrays of strings since SCRUM-21 (D52), a single string in older incidents. `resident_phone` (SCRUM-52, D59; Stage 2 [39]): the resident's phone (E.164; confirmed, else the stored unconfirmed one) when they share it; absent otherwise (show Call only when present). Keys not shared are left out.
  @JsonKey(name: 'share_payload')
  final Map<String, dynamic>? sharePayload;
  final IncidentSubmitResultStatus status;
  @JsonKey(name: 'submit_outcome')
  final IncidentSubmitResultSubmitOutcome submitOutcome;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$IncidentSubmitResultToJson(this));
}
