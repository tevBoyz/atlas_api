// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'batch_invite_item.g.dart';

@JsonSerializable()
class BatchInviteItem {
  const BatchInviteItem({required this.displayName, required this.phone});

  factory BatchInviteItem.fromJson(Map<String, Object?> json) =>
      _$BatchInviteItemFromJson(json);

  @JsonKey(name: 'display_name')
  final String displayName;

  /// Trimmed; 8-15 digits starting 1-9 get a leading `+`; then strict E.164.
  final String phone;

  Map<String, Object?> toJson() => _$BatchInviteItemToJson(this);
}
