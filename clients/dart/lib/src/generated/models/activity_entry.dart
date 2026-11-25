// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'activity_entry_category.dart';
import 'activity_entry_kind.dart';
import 'activity_incident.dart';
import 'detail.dart';

part 'activity_entry.g.dart';

@JsonSerializable()
class ActivityEntry {
  const ActivityEntry({
    required this.actorName,
    required this.category,
    required this.detail,
    required this.id,
    required this.incident,
    required this.kind,
    required this.occurredAt,
  });

  factory ActivityEntry.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$ActivityEntryFromJson(json), json);

  /// Who did it, by display name (D71): the resident, or the member for acknowledged / responding / unable. Null when nobody did (an automatic close).
  @JsonKey(name: 'actor_name')
  final String? actorName;

  /// "mine" = an alert the caller raised; "circle" = a circle alert of someone else.
  final ActivityEntryCategory category;

  /// status_update: {preset, text}; ended: {reason}; null for every other kind. Never location, medical or contact data.
  final Detail? detail;

  /// The underlying incident event id: unique, use it to drop duplicates when paging.
  final String id;
  final ActivityIncident incident;

  /// emergency_initiated (own alert sent; Sent), alert_received (a circle alert reached the caller; Received), location_shared (own alert, live location started; Active), acknowledged / responding / unable (a member acknowledged or set their response: on own alerts any member, on circle alerts the caller only), status_update (circle alerts: an update from the resident; detail.preset or detail.text), ended (once per alert: marked safe, or closed automatically; detail.reason).
  final ActivityEntryKind kind;

  /// Server time of the event (timestamptz).
  @JsonKey(name: 'occurred_at')
  final String occurredAt;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$ActivityEntryToJson(this));
}
