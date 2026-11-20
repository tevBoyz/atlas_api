// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/device_registered.dart';
import '../models/register_device_request.dart';

part 'devices_client.g.dart';

@RestApi()
abstract class DevicesClient {
  factory DevicesClient(Dio dio, {String? baseUrl}) = _DevicesClient;

  /// Register this app installation and its push token for the caller's account.
  ///
  /// [xAtlasInstallationId] - UUID the app generates once per install and keeps in its own storage (not the push token). Identifies this installation of the app for the signed-in user.
  @PUT('/v1/me/devices/current')
  Future<DeviceRegistered> registerCurrentDevice({
    @Header('X-Atlas-Installation-Id') required String xAtlasInstallationId,
    @Body() required RegisterDeviceRequest body,
  });

  /// Clear this installation's push token (sign-out).
  ///
  /// [xAtlasInstallationId] - UUID the app generates once per install and keeps in its own storage (not the push token). Identifies this installation of the app for the signed-in user.
  @DELETE('/v1/me/devices/current/push-token')
  Future<void> clearCurrentDevicePushToken({
    @Header('X-Atlas-Installation-Id') required String xAtlasInstallationId,
  });
}
