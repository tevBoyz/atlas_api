// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'incident_send.dart';

part 'open_incident_result.g.dart';

@JsonSerializable()
class OpenIncidentResult {
  const OpenIncidentResult({required this.openIncident});

  factory OpenIncidentResult.fromJson(Map<String, Object?> json) =>
      _$OpenIncidentResultFromJson(json);

  @JsonKey(name: 'open_incident')
  final IncidentSend? openIncident;

  Map<String, Object?> toJson() => _$OpenIncidentResultToJson(this);
}
