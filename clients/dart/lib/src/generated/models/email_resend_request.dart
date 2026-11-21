// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'email_resend_request_purpose.dart';

part 'email_resend_request.g.dart';

@JsonSerializable()
class EmailResendRequest {
  const EmailResendRequest({required this.email, this.purpose});

  factory EmailResendRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$EmailResendRequestFromJson(json), json);

  final String email;

  /// `signup` (default): a new confirmation link; `magic_link`: a sign-in link.
  final EmailResendRequestPurpose? purpose;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$EmailResendRequestToJson(this));
}
