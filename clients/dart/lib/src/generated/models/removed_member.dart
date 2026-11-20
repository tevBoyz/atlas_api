// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'removed_member.g.dart';

@JsonSerializable()
class RemovedMember {
  const RemovedMember({
    required this.circleId,
    required this.memberId,
    required this.removed,
  });

  factory RemovedMember.fromJson(Map<String, Object?> json) =>
      _$RemovedMemberFromJson(json);

  @JsonKey(name: 'circle_id')
  final String circleId;
  @JsonKey(name: 'member_id')
  final String memberId;
  final bool removed;

  Map<String, Object?> toJson() => _$RemovedMemberToJson(this);
}
