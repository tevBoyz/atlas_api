// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'emergency_service.dart';
import 'incident_details_emergency_type.dart';
import 'incident_details_location_source.dart';
import 'incident_details_status.dart';

part 'incident_details.g.dart';

@JsonSerializable()
class IncidentDetails {
  const IncidentDetails({
    required this.activatedAt,
    required this.autoClosed,
    required this.closedAt,
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
    required this.renotifiedAt,
    required this.residentName,
    required this.resolvedAt,
    required this.resolvedReason,
    required this.sentAt,
    required this.sharePayload,
    required this.sharePayloadAtActivation,
    required this.sharePayloadUpdatedAt,
    required this.status,
  });

  factory IncidentDetails.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$IncidentDetailsFromJson(json), json);

  @JsonKey(name: 'activated_at')
  final String activatedAt;
  @JsonKey(name: 'auto_closed')
  final bool autoClosed;

  /// SCRUM-63 (D61): when the incident became Closed (final, read-only); null until then. With status closed: resolved_reason safe = closed after the wrap-up following mark safe; ended with auto_closed true = closed automatically after inactivity.
  @JsonKey(name: 'closed_at')
  final String? closedAt;

  /// The local emergency numbers of the incident's region (SCRUM-54, D60), always in the order ambulance, police, fire_rescue; a service without a number is left out; `[]` when the region has none configured.
  @JsonKey(name: 'emergency_services')
  final List<EmergencyService> emergencyServices;
  @JsonKey(name: 'emergency_type')
  final IncidentDetailsEmergencyType emergencyType;
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
  final IncidentDetailsLocationSource? locationSource;

  /// SCRUM-68 (D74): since when the phone of the resident reports live location unavailable; null = live location is not reported unavailable. The location keys keep the last known fix (location_captured_at = when it was taken), so show it labelled "Last known · N min ago" with "Location unavailable". With no fix ever stored, location_source is unavailable and the position keys are null. The next fix clears it.
  @JsonKey(name: 'location_unavailable_since')
  final String? locationUnavailableSince;
  @JsonKey(name: 'renotified_at')
  final String? renotifiedAt;

  /// The resident's full name; empty string when unknown.
  @JsonKey(name: 'resident_name')
  final String residentName;
  @JsonKey(name: 'resolved_at')
  final String? resolvedAt;
  @JsonKey(name: 'resolved_reason')
  final String? resolvedReason;
  @JsonKey(name: 'sent_at')
  final String? sentAt;

  /// The LIVE shared info (SCRUM-21, D53): the latest shared fields when they changed them during the incident, else the activation snapshot; `{}` when none. Allergies / conditions: arrays of strings (a single string in older incidents).
  @JsonKey(name: 'share_payload')
  final Map<String, dynamic> sharePayload;

  /// What was shared at activation (what the alerts carried); never changes. `{}` when none.
  @JsonKey(name: 'share_payload_at_activation')
  final Map<String, dynamic> sharePayloadAtActivation;

  /// When the resident last changed the shared info during the incident; null = unchanged since activation.
  @JsonKey(name: 'share_payload_updated_at')
  final String? sharePayloadUpdatedAt;
  final IncidentDetailsStatus status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$IncidentDetailsToJson(this));
}
