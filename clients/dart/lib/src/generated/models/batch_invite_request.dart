// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'batch_invite_item.dart';

part 'batch_invite_request.g.dart';

@JsonSerializable()
class BatchInviteRequest {
  const BatchInviteRequest({required this.invites});

  factory BatchInviteRequest.fromJson(Map<String, Object?> json) =>
      _$BatchInviteRequestFromJson(json);

  /// Processed in array order, in one transaction. Not an array → `invalid_invites`.
  final List<BatchInviteItem> invites;

  Map<String, Object?> toJson() => _$BatchInviteRequestToJson(this);
}
