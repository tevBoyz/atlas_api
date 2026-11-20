// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'declined_invite.g.dart';

@JsonSerializable()
class DeclinedInvite {
  const DeclinedInvite({
    required this.circleId,
    required this.memberId,
    required this.ownerName,
    required this.status,
  });

  factory DeclinedInvite.fromJson(Map<String, Object?> json) =>
      _$DeclinedInviteFromJson(json);

  @JsonKey(name: 'circle_id')
  final String circleId;
  @JsonKey(name: 'member_id')
  final String memberId;

  /// The owner row's stored display name.
  @JsonKey(name: 'owner_name')
  final String? ownerName;
  final String status;

  Map<String, Object?> toJson() => _$DeclinedInviteToJson(this);
}
