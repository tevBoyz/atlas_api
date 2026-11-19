// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'live_location_config.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LiveLocationConfig _$LiveLocationConfigFromJson(Map<String, dynamic> json) =>
    LiveLocationConfig(
      intervalSeconds: (json['interval_seconds'] as num).toInt(),
      staleThresholdSeconds: (json['stale_threshold_seconds'] as num).toInt(),
    );

Map<String, dynamic> _$LiveLocationConfigToJson(LiveLocationConfig instance) =>
    <String, dynamic>{
      'interval_seconds': instance.intervalSeconds,
      'stale_threshold_seconds': instance.staleThresholdSeconds,
    };
