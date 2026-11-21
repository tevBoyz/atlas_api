// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'phone_change_request.g.dart';

@JsonSerializable()
class PhoneChangeRequest {
  const PhoneChangeRequest({required this.phone});

  factory PhoneChangeRequest.fromJson(Map<String, Object?> json) =>
      _$PhoneChangeRequestFromJson(json);

  /// The new number, strict `+E.164`.
  final String phone;

  Map<String, Object?> toJson() => _$PhoneChangeRequestToJson(this);
}
