// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'user_identity.dart';

part 'user.g.dart';

@JsonSerializable()
class User {
  const User({
    required this.createdAt,
    required this.email,
    required this.emailConfirmedAt,
    required this.id,
    required this.identities,
    required this.phone,
    required this.phoneConfirmedAt,
  });

  factory User.fromJson(Map<String, Object?> json) => _$UserFromJson(json);

  @JsonKey(name: 'created_at')
  final String createdAt;
  final String? email;
  @JsonKey(name: 'email_confirmed_at')
  final String? emailConfirmedAt;
  final String id;
  final List<UserIdentity> identities;

  /// `+E.164`.
  final String? phone;
  @JsonKey(name: 'phone_confirmed_at')
  final String? phoneConfirmedAt;

  Map<String, Object?> toJson() => _$UserToJson(this);
}
