// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'send_incident_update_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SendIncidentUpdateRequest _$SendIncidentUpdateRequestFromJson(
  Map<String, dynamic> json,
) => SendIncidentUpdateRequest(
  preset: json['preset'] == null
      ? null
      : SendIncidentUpdateRequestPreset.fromJson(json['preset'] as String),
  text: json['text'] as String?,
);

Map<String, dynamic> _$SendIncidentUpdateRequestToJson(
  SendIncidentUpdateRequest instance,
) => <String, dynamic>{'preset': instance.preset, 'text': instance.text};
