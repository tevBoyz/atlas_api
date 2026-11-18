import 'dart:convert';

import 'package:atlas_api_client/atlas_api_client.dart';
import 'package:dio/dio.dart';
import 'package:test/test.dart';

/// Answers every request with one canned JSON response.
class CannedAdapter implements HttpClientAdapter {
  CannedAdapter(this.status, this.body);

  final int status;
  final Object body;
  RequestOptions? last;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    last = options;
    return ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

AtlasApiClient clientWith(CannedAdapter adapter) {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
    ..httpClientAdapter = adapter;
  return AtlasApiClient(dio);
}

void main() {
  test('parses snake_case response properties', () async {
    final adapter = CannedAdapter(200, {
      'status': 'ok',
      'user_id': '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
    });
    final response = await clientWith(adapter).meta.ping();
    expect(response.userId, '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b');
    expect(adapter.last?.path, '/v1/ping');
  });

  test('parses the error envelope', () {
    final envelope = ErrorEnvelope.fromJson({
      'error': {
        'code': 'ping:not_authenticated',
        'message': 'Sign in to continue.',
        'details': <String, dynamic>{},
      },
    });
    expect(envelope.error.code, 'ping:not_authenticated');
  });

  test('publishes the enums with their stored values', () {
    expect(EmergencyType.domesticViolence.toJson(), 'domestic_violence');
    expect(LocationSource.lastKnown.toJson(), 'last_known');
  });
}
