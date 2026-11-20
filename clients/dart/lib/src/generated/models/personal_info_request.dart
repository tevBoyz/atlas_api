// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'gender.dart';

part 'personal_info_request.g.dart';

@JsonSerializable()
class PersonalInfoRequest {
  const PersonalInfoRequest({
    required this.dateOfBirth,
    required this.fullName,
    this.avatarPath,
    this.gender,
  });

  factory PersonalInfoRequest.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$PersonalInfoRequestFromJson(json), json);

  /// Null clears it; left out keeps the stored value. Else an object path in the caller's own folder: `{uid}/<name>` (`profiles:invalid_avatar_path`).
  @JsonKey(name: 'avatar_path')
  final String? avatarPath;

  /// `YYYY-MM-DD`, a real date not after today (Africa/Banjul = UTC) (`profiles:invalid_date_of_birth`).
  @JsonKey(name: 'date_of_birth')
  final String dateOfBirth;

  /// Trimmed; must not be empty (`profiles:invalid_full_name`).
  @JsonKey(name: 'full_name')
  final String fullName;

  /// Null clears it; left out keeps the stored value (null on a new profile).
  final Gender? gender;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$PersonalInfoRequestToJson(this));
}
