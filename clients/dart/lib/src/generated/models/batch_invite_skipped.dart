// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'batch_invite_skipped_reason.dart';

part 'batch_invite_skipped.g.dart';

@JsonSerializable()
class BatchInviteSkipped {
  const BatchInviteSkipped({
    required this.displayName,
    required this.memberId,
    required this.phone,
    required this.reason,
  });

  factory BatchInviteSkipped.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$BatchInviteSkippedFromJson(json), json);

  @JsonKey(name: 'display_name')
  final String displayName;
  @JsonKey(name: 'member_id')
  final String memberId;
  final String phone;
  final BatchInviteSkippedReason reason;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$BatchInviteSkippedToJson(this));
}
