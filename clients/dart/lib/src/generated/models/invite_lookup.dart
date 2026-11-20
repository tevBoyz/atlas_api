// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'invite_lookup_status.dart';

part 'invite_lookup.g.dart';

@JsonSerializable()
class InviteLookup {
  const InviteLookup({required this.inviteExpiresAt, required this.status});

  factory InviteLookup.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$InviteLookupFromJson(json), json);

  /// Null when the token is not found.
  @JsonKey(name: 'invite_expires_at')
  final String? inviteExpiresAt;
  final InviteLookupStatus status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$InviteLookupToJson(this));
}
