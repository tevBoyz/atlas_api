// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'batch_invite_not_created_reason.dart';

part 'batch_invite_not_created.g.dart';

@JsonSerializable()
class BatchInviteNotCreated {
  const BatchInviteNotCreated({
    required this.displayName,
    required this.phone,
    required this.reason,
  });

  factory BatchInviteNotCreated.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$BatchInviteNotCreatedFromJson(json), json);

  @JsonKey(name: 'display_name')
  final String? displayName;
  final String? phone;
  final BatchInviteNotCreatedReason reason;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$BatchInviteNotCreatedToJson(this));
}
