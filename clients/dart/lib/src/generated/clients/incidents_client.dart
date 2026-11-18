// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/incident_submit_result.dart';
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
}
