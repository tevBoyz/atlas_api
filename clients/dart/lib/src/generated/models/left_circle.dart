// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'left_circle.g.dart';

@JsonSerializable()
class LeftCircle {
  const LeftCircle({
    required this.circleId,
    required this.left,
    required this.memberId,
  });

  factory LeftCircle.fromJson(Map<String, Object?> json) =>
      _$LeftCircleFromJson(json);

  @JsonKey(name: 'circle_id')
  final String circleId;
  final bool left;

  /// The caller's member row, now ended (kept as history, status `left`).
  @JsonKey(name: 'member_id')
  final String memberId;

  Map<String, Object?> toJson() => _$LeftCircleToJson(this);
}
