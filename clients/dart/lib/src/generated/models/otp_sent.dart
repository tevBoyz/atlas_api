// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'otp_sent.g.dart';

@JsonSerializable()
class OtpSent {
  const OtpSent({
    required this.expiresInSeconds,
    required this.resendsRemaining,
  });

  factory OtpSent.fromJson(Map<String, Object?> json) =>
      _$OtpSentFromJson(json);

  @JsonKey(name: 'expires_in_seconds')
  final int expiresInSeconds;
  @JsonKey(name: 'resends_remaining')
  final int resendsRemaining;

  Map<String, Object?> toJson() => _$OtpSentToJson(this);
}
