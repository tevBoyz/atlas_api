// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'verification.dart';

part 'signup_accepted.g.dart';

@JsonSerializable()
class SignupAccepted {
  const SignupAccepted({required this.verification});

  factory SignupAccepted.fromJson(Map<String, Object?> json) =>
      _$SignupAcceptedFromJson(json);

  final Verification verification;

  Map<String, Object?> toJson() => _$SignupAcceptedToJson(this);
}
