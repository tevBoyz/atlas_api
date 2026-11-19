// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/delivery_counts.dart';
import '../models/incident_details.dart';
import '../models/incident_event.dart';
import '../models/incident_send.dart';
import '../models/incident_shared.dart';
import '../models/incident_submit_result.dart';
import '../models/open_incident_result.dart';
import '../models/recent_incident.dart';
import '../models/responder_incident.dart';
import '../models/set_incident_notes_request.dart';
import '../models/submit_emergency_alert_request.dart';

part 'incidents_client.g.dart';

@RestApi()
abstract class IncidentsClient {
  factory IncidentsClient(Dio dio, {String? baseUrl}) = _IncidentsClient;

  /// Create the emergency alert, or re-notify the one already open.
  ///
  /// [idempotencyKey] - UUID chosen by the client. A retry with the same key replays the first result.
  @POST('/v1/incidents')
  Future<IncidentSubmitResult> submitEmergencyAlert({
    @Header('Idempotency-Key') required String idempotencyKey,
    @Body() required SubmitEmergencyAlertRequest body,
  });

  /// One alert as a circle member sees it (type, location, note, shared fields)
  @GET('/v1/incidents/{id}')
  Future<IncidentDetails> getIncidentDetails({@Path('id') required String id});

  /// Acknowledge the alert as one of its recipients (the caller's own delivery)
  @POST('/v1/incidents/{id}/acknowledge')
  Future<DeliveryCounts> acknowledgeIncident({@Path('id') required String id});

  /// How many members received and acknowledged the alert (in-app)
  @GET('/v1/incidents/{id}/delivery-counts')
  Future<DeliveryCounts> incidentDeliveryCounts({
    @Path('id') required String id,
  });

  /// The alert's event log, oldest first
  @GET('/v1/incidents/{id}/events')
  Future<List<IncidentEvent>> listIncidentEvents({
    @Path('id') required String id,
  });

  /// Mark the caller's alert safe and close it.
  ///
  /// [idempotencyKey] - UUID chosen by the client. A retry with the same key replays the first result.
  @POST('/v1/incidents/{id}/mark-safe')
  Future<IncidentSend> markIncidentSafe({
    @Path('id') required String id,
    @Header('Idempotency-Key') required String idempotencyKey,
  });

  /// Set or clear the live note on the caller's open alert
  @PUT('/v1/incidents/{id}/notes')
  Future<IncidentShared> setIncidentNotes({
    @Path('id') required String id,
    @Body() required SetIncidentNotesRequest body,
  });

  /// Re-notify the members of the caller's active alert
  @POST('/v1/incidents/{id}/renotify')
  Future<IncidentSend> renotifyEmergencyAlert({@Path('id') required String id});

  /// The active and resolved incidents of the caller, newest first
  @GET('/v1/me/incidents')
  Future<List<RecentIncident>> listMyRecentIncidents({
    @Query('limit') int? limit,
  });

  /// The active incident of the caller, to restore Alert Sent after a restart or a lost response
  @GET('/v1/me/incidents/open')
  Future<OpenIncidentResult> getMyOpenIncident();

  /// The alerts of the circles the caller belongs to (from when they joined), newest first
  @GET('/v1/responder/incidents')
  Future<List<ResponderIncident>> listResponderIncidents();
}
