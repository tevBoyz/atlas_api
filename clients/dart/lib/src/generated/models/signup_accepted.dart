// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'signup_verification.dart';
import 'verification.dart';

part 'signup_accepted.g.dart';

@JsonSerializable()
class SignupAccepted {
  const SignupAccepted({
    required this.verification,
    required this.verifications,
  });

  factory SignupAccepted.fromJson(Map<String, Object?> json) =>
      _$SignupAcceptedFromJson(json);

  /// The first of `verifications` (the email link when an email was given, else the phone code).
  final Verification verification;

  /// D78: every verification sent, email first (one per contact given).
  final List<SignupVerification> verifications;

  Map<String, Object?> toJson() => _$SignupAcceptedToJson(this);
}
