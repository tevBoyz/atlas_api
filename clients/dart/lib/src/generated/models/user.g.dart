// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'user.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

User _$UserFromJson(Map<String, dynamic> json) => User(
  createdAt: json['created_at'] as String,
  email: json['email'] as String?,
  emailConfirmedAt: json['email_confirmed_at'] as String?,
  id: json['id'] as String,
  identities: (json['identities'] as List<dynamic>)
      .map((e) => UserIdentity.fromJson(e as Map<String, dynamic>))
      .toList(),
  phone: json['phone'] as String?,
  phoneConfirmedAt: json['phone_confirmed_at'] as String?,
);

Map<String, dynamic> _$UserToJson(User instance) => <String, dynamic>{
  'created_at': instance.createdAt,
  'email': instance.email,
  'email_confirmed_at': instance.emailConfirmedAt,
  'id': instance.id,
  'identities': instance.identities,
  'phone': instance.phone,
  'phone_confirmed_at': instance.phoneConfirmedAt,
};
