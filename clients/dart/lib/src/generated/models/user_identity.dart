// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'identity_provider.dart';

part 'user_identity.g.dart';

@JsonSerializable()
class UserIdentity {
  const UserIdentity({required this.createdAt, required this.provider});

  factory UserIdentity.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$UserIdentityFromJson(json), json);

  @JsonKey(name: 'created_at')
  final String createdAt;
  final IdentityProvider provider;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$UserIdentityToJson(this));
}
