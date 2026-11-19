// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'batch_invite_not_created.dart';
import 'batch_invite_skipped.dart';
import 'member_invite_payload.dart';

part 'batch_invite_result.g.dart';

@JsonSerializable()
class BatchInviteResult {
  const BatchInviteResult({
    required this.availableAfter,
    required this.created,
    required this.notCreated,
    required this.skipped,
  });

  factory BatchInviteResult.fromJson(Map<String, Object?> json) =>
      _$BatchInviteResultFromJson(json);

  /// Free slots after the batch (Capacity.available).
  @JsonKey(name: 'available_after')
  final int availableAfter;

  /// New rows (`resent: false`) and refreshed expired/declined rows (`resent: true`).
  final List<MemberInvitePayload> created;
  @JsonKey(name: 'not_created')
  final List<BatchInviteNotCreated> notCreated;
  final List<BatchInviteSkipped> skipped;

  Map<String, Object?> toJson() => _$BatchInviteResultToJson(this);
}
