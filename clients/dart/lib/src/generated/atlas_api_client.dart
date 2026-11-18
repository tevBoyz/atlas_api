// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';

import 'clients/health_client.dart';
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
  MetaClient? _meta;

  HealthClient get health => _health ??= HealthClient(_dio, baseUrl: _baseUrl);

  MetaClient get meta => _meta ??= MetaClient(_dio, baseUrl: _baseUrl);
}
