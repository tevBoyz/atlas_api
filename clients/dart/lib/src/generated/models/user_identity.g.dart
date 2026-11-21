// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'user_identity.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

UserIdentity _$UserIdentityFromJson(Map<String, dynamic> json) => UserIdentity(
  createdAt: json['created_at'] as String,
  provider: IdentityProvider.fromJson(json['provider'] as String),
);

Map<String, dynamic> _$UserIdentityToJson(UserIdentity instance) =>
    <String, dynamic>{
      'created_at': instance.createdAt,
      'provider': instance.provider,
    };
