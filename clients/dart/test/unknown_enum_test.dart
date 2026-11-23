import 'dart:convert';

import 'package:atlas_api_client/atlas_api_client.dart';
import 'package:test/test.dart';

/// A server value the client does not know yet must survive fromJson -> toJson (the app converts
/// generated models with toJson and its own fromJson). See lib/src/unknown_enum_values.dart.
Map<String, Object?> incidentDetailsJson({
  required String status,
  required String emergencyType,
  required String? locationSource,
}) => {
  'activated_at': '2026-11-18T10:00:00.123456+00:00',
  'auto_closed': false,
  'emergency_type': emergencyType,
  'id': '7a1c9e52-4b3d-4f6a-9c8e-2d1b0a3f4e5c',
  'incident_notes': null,
  'incident_notes_updated_at': null,
  'location_accuracy_m': 12.5,
  'location_captured_at': '2026-11-18T10:00:01+00:00',
  'location_lat': 9.03,
  'location_lng': 38.74,
  'location_sharing_ended_at': null,
  'location_source': locationSource,
  'renotified_at': null,
  'resident_name': 'Test Resident',
  'resolved_at': null,
  'resolved_reason': null,
  'sent_at': '2026-11-18T10:00:00.123456+00:00',
  'share_payload': {
    'blood_type': 'O+',
    'allergies': ['Peanuts', 'Latex'],
  },
  // SCRUM-21 (D53): the activation snapshot and when the live view last changed.
  'share_payload_at_activation': {'blood_type': 'O+', 'allergies': 'Peanuts'},
  'share_payload_updated_at': '2026-11-18T10:05:00+00:00',
  'status': status,
};

void main() {
  group('unknown enum values', () {
    test(
      'unknown status, emergency_type and location_source parse and toJson returns the original strings',
      () {
        final json = incidentDetailsJson(
          status: 'paused',
          emergencyType: 'earthquake',
          locationSource: 'satellite',
        );
        final model = IncidentDetails.fromJson(json);

        expect(model.status, IncidentDetailsStatus.$unknown);
        expect(model.emergencyType, IncidentDetailsEmergencyType.$unknown);
        expect(model.locationSource, IncidentDetailsLocationSource.$unknown);

        final out = model.toJson();
        expect(out['status'], 'paused');
        expect(out['emergency_type'], 'earthquake');
        expect(out['location_source'], 'satellite');
        expect(out, json);
        expect(jsonDecode(jsonEncode(model)), json);
      },
    );

    test('known values are unchanged', () {
      final json = incidentDetailsJson(
        status: 'active',
        emergencyType: 'medical',
        locationSource: 'last_known',
      );
      final model = IncidentDetails.fromJson(json);

      expect(model.status, IncidentDetailsStatus.active);
      expect(model.emergencyType, IncidentDetailsEmergencyType.medical);
      expect(model.locationSource, IncidentDetailsLocationSource.lastKnown);
      expect(model.toJson(), json);
      expect(model.toJson()['status'], isA<String>());
    });

    test('a hand-made request serializes its enum as the stored string', () {
      const body = SubmitEmergencyAlertRequest(
        emergencyType:
            SubmitEmergencyAlertRequestEmergencyType.domesticViolence,
      );
      expect(body.toJson()['emergency_type'], 'domestic_violence');
    });

    test('a null location_source stays null', () {
      final json = incidentDetailsJson(
        status: 'resolved',
        emergencyType: 'fire',
        locationSource: null,
      );
      final model = IncidentDetails.fromJson(json);
      expect(model.locationSource, isNull);
      expect(model.toJson(), json);
    });

    test('other models round-trip unknown values too', () {
      final json = <String, Object?>{
        'activated_at': '2026-11-18T10:00:00+00:00',
        'emergency_type': 'earthquake',
        'id': '7a1c9e52-4b3d-4f6a-9c8e-2d1b0a3f4e5c',
        'resolved_at': null,
        'resolved_reason': null,
        'sent_at': null,
        'status': 'paused',
      };
      final recent = RecentIncident.fromJson(json);
      expect(recent.status, RecentIncidentStatus.$unknown);
      expect(recent.emergencyType, RecentIncidentEmergencyType.$unknown);
      expect(recent.toJson(), json);
    });

    test(
      'an enum toJson never throws: null for \$unknown, the value otherwise',
      () {
        expect(IncidentDetailsStatus.fromJson('paused').toJson(), isNull);
        expect(IncidentDetailsStatus.fromJson('active').toJson(), 'active');
        expect(
          IncidentDetailsEmergencyType.fromJson('earthquake').toJson(),
          isNull,
        );
        expect(LocationSource.fromJson('satellite').toJson(), isNull);
      },
    );
  });
}
