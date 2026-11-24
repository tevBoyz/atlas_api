// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'test_alert_status.dart';

part 'latest_test_alert.g.dart';

@JsonSerializable()
class LatestTestAlert {
  const LatestTestAlert({required this.testAlert});

  factory LatestTestAlert.fromJson(Map<String, Object?> json) =>
      _$LatestTestAlertFromJson(json);

  /// Null when the caller never sent a test alert.
  @JsonKey(name: 'test_alert')
  final TestAlertStatus? testAlert;

  Map<String, Object?> toJson() => _$LatestTestAlertToJson(this);
}
