// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'safety_circle.g.dart';

@JsonSerializable()
class SafetyCircle {
  const SafetyCircle({
    required this.createdAt,
    required this.id,
    required this.name,
    required this.ownerId,
    required this.updatedAt,
  });

  factory SafetyCircle.fromJson(Map<String, Object?> json) =>
      _$SafetyCircleFromJson(json);

  @JsonKey(name: 'created_at')
  final String createdAt;
  final String id;
  final String name;
  @JsonKey(name: 'owner_id')
  final String ownerId;
  @JsonKey(name: 'updated_at')
  final String updatedAt;

  Map<String, Object?> toJson() => _$SafetyCircleToJson(this);
}
