// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'activity_entry.dart';

part 'activity_page.g.dart';

@JsonSerializable()
class ActivityPage {
  const ActivityPage({required this.entries, required this.nextCursor});

  factory ActivityPage.fromJson(Map<String, Object?> json) =>
      _$ActivityPageFromJson(json);

  /// Newest first: occurred_at descending, then id descending.
  final List<ActivityEntry> entries;

  /// Pass as `before` for the next (older) page; null when there is no more.
  @JsonKey(name: 'next_cursor')
  final String? nextCursor;

  Map<String, Object?> toJson() => _$ActivityPageToJson(this);
}
