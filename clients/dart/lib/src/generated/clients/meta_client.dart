// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/open_api_document.dart';
import '../models/ping_response.dart';

part 'meta_client.g.dart';

@RestApi()
abstract class MetaClient {
  factory MetaClient(Dio dio, {String? baseUrl}) = _MetaClient;

  /// The OpenAPI document of this API (never served in production)
  @GET('/v1/openapi.json')
  Future<OpenApiDocument> getOpenApiDocument();

  /// Scaffold route: echoes the authenticated caller
  @GET('/v1/ping')
  Future<PingResponse> ping();
}
