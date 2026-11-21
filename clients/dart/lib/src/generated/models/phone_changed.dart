// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'user.dart';

part 'phone_changed.g.dart';

@JsonSerializable()
class PhoneChanged {
  const PhoneChanged({required this.user});

  factory PhoneChanged.fromJson(Map<String, Object?> json) =>
      _$PhoneChangedFromJson(json);

  final User user;

  Map<String, Object?> toJson() => _$PhoneChangedToJson(this);
}
