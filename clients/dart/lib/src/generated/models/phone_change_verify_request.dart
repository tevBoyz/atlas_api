// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'phone_change_verify_request.g.dart';

@JsonSerializable()
class PhoneChangeVerifyRequest {
  const PhoneChangeVerifyRequest({required this.code, required this.phone});

  factory PhoneChangeVerifyRequest.fromJson(Map<String, Object?> json) =>
      _$PhoneChangeVerifyRequestFromJson(json);

  /// 6 digits.
  final String code;

  /// The new number of the pending change.
  final String phone;

  Map<String, Object?> toJson() => _$PhoneChangeVerifyRequestToJson(this);
}
