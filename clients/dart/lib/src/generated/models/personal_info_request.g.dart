// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'personal_info_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PersonalInfoRequest _$PersonalInfoRequestFromJson(Map<String, dynamic> json) =>
    PersonalInfoRequest(
      dateOfBirth: json['date_of_birth'] as String,
      fullName: json['full_name'] as String,
      avatarPath: json['avatar_path'] as String?,
      gender: json['gender'] == null
          ? null
          : Gender.fromJson(json['gender'] as String),
    );

Map<String, dynamic> _$PersonalInfoRequestToJson(
  PersonalInfoRequest instance,
) => <String, dynamic>{
  'avatar_path': instance.avatarPath,
  'date_of_birth': instance.dateOfBirth,
  'full_name': instance.fullName,
  'gender': instance.gender,
};
