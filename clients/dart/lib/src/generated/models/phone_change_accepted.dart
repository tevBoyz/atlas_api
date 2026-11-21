// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'phone_change_verification.dart';

part 'phone_change_accepted.g.dart';

@JsonSerializable()
class PhoneChangeAccepted {
  const PhoneChangeAccepted({required this.verification});

  factory PhoneChangeAccepted.fromJson(Map<String, Object?> json) =>
      _$PhoneChangeAcceptedFromJson(json);

  final PhoneChangeVerification verification;

  Map<String, Object?> toJson() => _$PhoneChangeAcceptedToJson(this);
}
