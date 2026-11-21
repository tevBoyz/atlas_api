// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'phone_change_verification.g.dart';

@JsonSerializable()
class PhoneChangeVerification {
  const PhoneChangeVerification({
    required this.channel,
    required this.expiresInSeconds,
    required this.resendsRemaining,
  });

  factory PhoneChangeVerification.fromJson(Map<String, Object?> json) =>
      _$PhoneChangeVerificationFromJson(json);

  final String channel;

  /// Lifetime of the texted code (600 s).
  @JsonKey(name: 'expires_in_seconds')
  final int expiresInSeconds;
  @JsonKey(name: 'resends_remaining')
  final int resendsRemaining;

  Map<String, Object?> toJson() => _$PhoneChangeVerificationToJson(this);
}
