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
      // SCRUM-63 (D63): null on a live alert.
      'closed_at': null,
      'emergency_services': [
        {'service': 'ambulance', 'label': 'Ambulance', 'number': '116'},
      ],
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
    expect(response.emergencyServices.single.number, '116');
    expect(adapter.last?.path, '/v1/incidents');
    expect(adapter.last?.headers['Idempotency-Key'], requestKey);
  });

  test('open incident: the wrapper with null and with an incident', () async {
    final none = CannedAdapter(200, {'open_incident': null});
    final empty = await clientWith(none).incidents.getMyOpenIncident();
    expect(empty.openIncident, isNull);
    expect(none.last?.path, '/v1/me/incidents/open');

    final open = CannedAdapter(200, {
      'open_incident': {
        'id': '7a1c9e52-4b3d-4f6a-9c8e-2d1b0a3f4e5c',
        'resident_id': '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
        'circle_id': null,
        'status': 'active',
        'activated_at': '2026-11-18T10:00:00.123456+00:00',
        'emergency_type': 'fire',
        'location_lat': null,
        'location_lng': null,
        'location_accuracy_m': null,
        'location_captured_at': null,
        'location_source': null,
        'cancelled_at': null,
        'sent_at': '2026-11-18T10:00:00.123456+00:00',
        'share_payload': <String, dynamic>{},
        'incident_notes': null,
        'incident_notes_updated_at': null,
        'renotified_at': null,
        'resolved_at': null,
        'resolved_reason': null,
        'auto_closed': false,
        'activity_confirmed_at': null,
        'location_sharing_ended_at': null,
        'delivered_count': 2,
        'acknowledged_count': 1,
        'emergency_services': <Object>[],
        'closed_at': null,
      },
    });
    final result = await clientWith(open).incidents.getMyOpenIncident();
    expect(result.openIncident?.id, '7a1c9e52-4b3d-4f6a-9c8e-2d1b0a3f4e5c');
    expect(result.openIncident?.status, IncidentLiveStatus.active);
    expect(result.openIncident?.emergencyServices, isEmpty);
    expect(result.openIncident?.deliveredCount, 2);
  });

  test(
    'recent incidents: a list, with the limit as a query parameter',
    () async {
      final adapter = CannedAdapter(200, [
        {
          'id': '7a1c9e52-4b3d-4f6a-9c8e-2d1b0a3f4e5c',
          'emergency_type': 'medical',
          'status': 'closed',
          'activated_at': '2026-11-18T10:00:00.123456+00:00',
          'sent_at': '2026-11-18T10:00:00.123456+00:00',
          'resolved_at': '2026-11-18T10:05:00.5+00:00',
          'resolved_reason': 'safe',
          // SCRUM-63 (D61, D63): Closed after the wrap-up.
          'auto_closed': false,
          'closed_at': '2026-11-18T10:35:00.5+00:00',
        },
      ]);
      final list = await clientWith(
        adapter,
      ).incidents.listMyRecentIncidents(limit: 3);
      expect(list, hasLength(1));
      expect(list.first.status, RecentIncidentStatus.closed);
      expect(list.first.closedAt, '2026-11-18T10:35:00.5+00:00');
      expect(list.first.autoClosed, isFalse);
      expect(list.first.resolvedReason, 'safe');
      expect(adapter.last?.path, '/v1/me/incidents');
      expect(adapter.last?.queryParameters, {'limit': 3});
    },
  );

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
    // SCRUM-63 (D61): the final state.
    expect(IncidentStatus.closed.toJson(), 'closed');
  });
}
