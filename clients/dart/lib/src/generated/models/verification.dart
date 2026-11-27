// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'channel.dart';

part 'verification.g.dart';

@JsonSerializable()
class Verification {
  const Verification({required this.channel, required this.expiresInSeconds});

  factory Verification.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$VerificationFromJson(json), json);

  /// email: a link was emailed; phone: a code was texted.
  final Channel channel;

  /// Lifetime of the link or the code.
  @JsonKey(name: 'expires_in_seconds')
  final int expiresInSeconds;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$VerificationToJson(this));
}
