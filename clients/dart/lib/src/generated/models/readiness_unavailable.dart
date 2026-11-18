// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'readiness_unavailable_failed.dart';

part 'readiness_unavailable.g.dart';

@JsonSerializable()
class ReadinessUnavailable {
  const ReadinessUnavailable({required this.failed, required this.status});

  factory ReadinessUnavailable.fromJson(Map<String, Object?> json) =>
      _$ReadinessUnavailableFromJson(json);

  final List<ReadinessUnavailableFailed> failed;
  final String status;

  Map<String, Object?> toJson() => _$ReadinessUnavailableToJson(this);
}
