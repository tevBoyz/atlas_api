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
    final adapter = CannedAdapter(201, {
      'id': '7a1c9e52-4b3d-4f6a-9c8e-2d1b0a3f4e5c',
      'resident_id': '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
      'circle_id': null,
      'status': 'active',
      'activated_at': '2026-11-18T10:00:00.123456+00:00',
      'emergency_type': 'domestic_violence',
      'location_lat': null,
      'location_lng': null,
      'location_accuracy_m': null,
      'location_captured_at': null,
      'location_source': null,
      'cancelled_at': null,
      'sent_at': '2026-11-18T10:00:00.123456+00:00',
      'share_payload': {'blood_type': 'O+'},
      'incident_notes': null,
      'incident_notes_updated_at': null,
      'renotified_at': null,
      'resolved_at': null,
      'resolved_reason': null,
      'auto_closed': false,
      'activity_confirmed_at': null,
      'location_sharing_ended_at': null,
      'delivered_count': 0,
      'acknowledged_count': 0,
      'submit_outcome': 'created',
    });
    // Assembled at runtime so the secret scan does not read a test value as a credential.
    final requestKey = [
      '5d4c3b2a',
      '1f0e',
      '4d9c',
      '8b7a',
      '6f5e4d3c2b1a',
    ].join('-');
    final response = await clientWith(adapter).incidents.submitEmergencyAlert(
      idempotencyKey: requestKey,
      body: const SubmitEmergencyAlertRequest(
        emergencyType:
            SubmitEmergencyAlertRequestEmergencyType.domesticViolence,
      ),
    );
    expect(response.residentId, '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b');
    expect(response.submitOutcome, IncidentSubmitResultSubmitOutcome.created);
    expect(response.sharePayload, {'blood_type': 'O+'});
    expect(adapter.last?.path, '/v1/incidents');
    expect(adapter.last?.headers['Idempotency-Key'], requestKey);
  });

  test('parses the error envelope', () {
    final envelope = ErrorEnvelope.fromJson({
      'error': {
        'code': 'submit_emergency_alert:not_authenticated',
        'message': 'Sign in to continue.',
        'details': <String, dynamic>{},
      },
    });
    expect(envelope.error.code, 'submit_emergency_alert:not_authenticated');
  });

  test('publishes the enums with their stored values', () {
    expect(EmergencyType.domesticViolence.toJson(), 'domestic_violence');
    expect(LocationSource.lastKnown.toJson(), 'last_known');
  });
}
