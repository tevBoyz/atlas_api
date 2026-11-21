// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'verification.g.dart';

@JsonSerializable()
class Verification {
  const Verification({required this.channel, required this.expiresInSeconds});

  factory Verification.fromJson(Map<String, Object?> json) =>
      _$VerificationFromJson(json);

  final String channel;

  /// Lifetime of the emailed link.
  @JsonKey(name: 'expires_in_seconds')
  final int expiresInSeconds;

  Map<String, Object?> toJson() => _$VerificationToJson(this);
}
