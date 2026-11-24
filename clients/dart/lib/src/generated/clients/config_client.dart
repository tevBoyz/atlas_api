// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/emergency_numbers.dart';
import '../models/live_location_config.dart';

part 'config_client.g.dart';

@RestApi()
abstract class ConfigClient {
  factory ConfigClient(Dio dio, {String? baseUrl}) = _ConfigClient;

  /// The local emergency numbers (ambulance, police, fire and rescue)
  @GET('/v1/config/emergency-numbers')
  Future<EmergencyNumbers> getEmergencyNumbers();

  /// The live-location upload interval and stale threshold, in seconds
  @GET('/v1/config/live-location')
  Future<LiveLocationConfig> getLiveLocationConfig();
}
