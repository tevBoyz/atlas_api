// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'phone_invite_request_relationship.dart';

part 'phone_invite_request.g.dart';

@JsonSerializable()
class PhoneInviteRequest {
  const PhoneInviteRequest({
    required this.displayName,
    required this.phone,
    this.relationship,
  });

  factory PhoneInviteRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$PhoneInviteRequestFromJson(json), json);

  /// Trimmed (spaces); must not be empty.
  @JsonKey(name: 'display_name')
  final String displayName;

  /// Strict E.164 after trimming (spaces): `^\+[1-9][0-9]{7,14}$`.
  final String phone;

  /// Spec §4.4: one of the 7 relationship values.
  final PhoneInviteRequestRelationship? relationship;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$PhoneInviteRequestToJson(this));
}
