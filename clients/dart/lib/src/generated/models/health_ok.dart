// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'health_ok.g.dart';

@JsonSerializable()
class HealthOk {
  const HealthOk({required this.status});

  factory HealthOk.fromJson(Map<String, Object?> json) =>
      _$HealthOkFromJson(json);

  final String status;

  Map<String, Object?> toJson() => _$HealthOkToJson(this);
}
