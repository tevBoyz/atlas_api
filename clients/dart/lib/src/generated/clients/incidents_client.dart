// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/incident_send.dart';
import '../models/incident_shared.dart';
import '../models/incident_submit_result.dart';
import '../models/open_incident_result.dart';
import '../models/recent_incident.dart';
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
}
