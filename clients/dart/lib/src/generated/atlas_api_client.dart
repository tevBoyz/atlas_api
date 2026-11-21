// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';

import 'clients/health_client.dart';
import 'clients/auth_client.dart';
import 'clients/circles_client.dart';
import 'clients/config_client.dart';
import 'clients/incidents_client.dart';
import 'clients/locations_client.dart';
import 'clients/invites_client.dart';
import 'clients/profiles_client.dart';
import 'clients/devices_client.dart';
import 'clients/meta_client.dart';

/// Atlas API `v0.1.0`.
///
/// Atlas backend API. JSON properties are snake_case. Every non-2xx response uses the error envelope; `error.code` keeps the `fn:code` strings of the original SQL functions.
class AtlasApiClient {
  AtlasApiClient(Dio dio, {String? baseUrl}) : _dio = dio, _baseUrl = baseUrl;

  final Dio _dio;
  final String? _baseUrl;

  static String get version => '0.1.0';

  HealthClient? _health;
  AuthClient? _auth;
  CirclesClient? _circles;
  ConfigClient? _config;
  IncidentsClient? _incidents;
  LocationsClient? _locations;
  InvitesClient? _invites;
  ProfilesClient? _profiles;
  DevicesClient? _devices;
  MetaClient? _meta;

  HealthClient get health => _health ??= HealthClient(_dio, baseUrl: _baseUrl);

  AuthClient get auth => _auth ??= AuthClient(_dio, baseUrl: _baseUrl);

  CirclesClient get circles =>
      _circles ??= CirclesClient(_dio, baseUrl: _baseUrl);

  ConfigClient get config => _config ??= ConfigClient(_dio, baseUrl: _baseUrl);

  IncidentsClient get incidents =>
      _incidents ??= IncidentsClient(_dio, baseUrl: _baseUrl);

  LocationsClient get locations =>
      _locations ??= LocationsClient(_dio, baseUrl: _baseUrl);

  InvitesClient get invites =>
      _invites ??= InvitesClient(_dio, baseUrl: _baseUrl);

  ProfilesClient get profiles =>
      _profiles ??= ProfilesClient(_dio, baseUrl: _baseUrl);

  DevicesClient get devices =>
      _devices ??= DevicesClient(_dio, baseUrl: _baseUrl);

  MetaClient get meta => _meta ??= MetaClient(_dio, baseUrl: _baseUrl);
}
