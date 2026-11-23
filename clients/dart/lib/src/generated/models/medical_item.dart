// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'medical_item.g.dart';

@JsonSerializable()
class MedicalItem {
  const MedicalItem({
    required this.id,
    required this.text,
    required this.updatedAt,
  });

  factory MedicalItem.fromJson(Map<String, Object?> json) =>
      _$MedicalItemFromJson(json);

  final String id;

  /// 1-100 characters, trimmed (an item from the old free text may be longer).
  final String text;

  /// When the item was added or last edited.
  @JsonKey(name: 'updated_at')
  final String updatedAt;

  Map<String, Object?> toJson() => _$MedicalItemToJson(this);
}
