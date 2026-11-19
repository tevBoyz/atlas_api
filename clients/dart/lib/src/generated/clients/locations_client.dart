// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/attach_incident_location_request.dart';
import '../models/incident_shared.dart';

part 'locations_client.g.dart';

@RestApi()
abstract class LocationsClient {
  factory LocationsClient(Dio dio, {String? baseUrl}) = _LocationsClient;

  /// Upload the resident's live location to their active alert
  @POST('/v1/incidents/{id}/locations')
  Future<IncidentShared> attachIncidentLocation({
    @Path('id') required String id,
    @Body() required AttachIncidentLocationRequest body,
  });
}
