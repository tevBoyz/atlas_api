// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'live_location_config.g.dart';

@JsonSerializable()
class LiveLocationConfig {
  const LiveLocationConfig({
    required this.intervalSeconds,
    required this.staleThresholdSeconds,
  });

  factory LiveLocationConfig.fromJson(Map<String, Object?> json) =>
      _$LiveLocationConfigFromJson(json);

  /// Seconds between location uploads while an alert is active (default 12).
  @JsonKey(name: 'interval_seconds')
  final int intervalSeconds;

  /// A fix older than this many seconds is shown as stale (default 45).
  @JsonKey(name: 'stale_threshold_seconds')
  final int staleThresholdSeconds;

  Map<String, Object?> toJson() => _$LiveLocationConfigToJson(this);
}
