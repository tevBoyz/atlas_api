// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'open_incident_result.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OpenIncidentResult _$OpenIncidentResultFromJson(Map<String, dynamic> json) =>
    OpenIncidentResult(
      openIncident: json['open_incident'] == null
          ? null
          : IncidentLive.fromJson(
              json['open_incident'] as Map<String, dynamic>,
            ),
    );

Map<String, dynamic> _$OpenIncidentResultToJson(OpenIncidentResult instance) =>
    <String, dynamic>{'open_incident': instance.openIncident};
