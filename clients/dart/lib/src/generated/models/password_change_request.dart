// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'password_change_request.g.dart';

@JsonSerializable()
class PasswordChangeRequest {
  const PasswordChangeRequest({
    required this.currentPassword,
    required this.newPassword,
  });

  factory PasswordChangeRequest.fromJson(Map<String, Object?> json) =>
      _$PasswordChangeRequestFromJson(json);

  @JsonKey(name: 'current_password')
  final String currentPassword;
  @JsonKey(name: 'new_password')
  final String newPassword;

  Map<String, Object?> toJson() => _$PasswordChangeRequestToJson(this);
}
