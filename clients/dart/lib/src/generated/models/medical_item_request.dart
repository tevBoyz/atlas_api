// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'medical_item_request.g.dart';

@JsonSerializable()
class MedicalItemRequest {
  const MedicalItemRequest({required this.text});

  factory MedicalItemRequest.fromJson(Map<String, Object?> json) =>
      _$MedicalItemRequestFromJson(json);

  /// Trimmed; 1-100 characters (`profiles:invalid_medical_item`); not the same as another item of the list, ignoring case (`profiles:duplicate_medical_item`).
  final String text;

  Map<String, Object?> toJson() => _$MedicalItemRequestToJson(this);
}
