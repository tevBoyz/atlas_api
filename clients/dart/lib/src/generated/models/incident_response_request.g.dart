// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'incident_response_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

IncidentResponseRequest _$IncidentResponseRequestFromJson(
  Map<String, dynamic> json,
) => IncidentResponseRequest(
  status: IncidentResponseRequestStatus.fromJson(json['status'] as String),
);

Map<String, dynamic> _$IncidentResponseRequestToJson(
  IncidentResponseRequest instance,
) => <String, dynamic>{'status': instance.status};
