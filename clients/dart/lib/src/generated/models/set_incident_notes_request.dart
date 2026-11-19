// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'set_incident_notes_request.g.dart';

@JsonSerializable()
class SetIncidentNotesRequest {
  const SetIncidentNotesRequest({this.incidentNotes});

  factory SetIncidentNotesRequest.fromJson(Map<String, Object?> json) =>
      _$SetIncidentNotesRequestFromJson(json);

  /// Trimmed of spaces; empty or only spaces clears the note (null). At most 250 characters after trimming, else 422 set_incident_notes:too_long.
  @JsonKey(name: 'incident_notes')
  final String? incidentNotes;

  Map<String, Object?> toJson() => _$SetIncidentNotesRequestToJson(this);
}
