// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'jwk.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Jwk _$JwkFromJson(Map<String, dynamic> json) => Jwk(
  alg: JwkAlg.fromJson(json['alg'] as String),
  crv: json['crv'] as String,
  kid: json['kid'] as String,
  kty: json['kty'] as String,
  use: json['use'] as String,
  x: json['x'] as String,
  y: json['y'] as String?,
);

Map<String, dynamic> _$JwkToJson(Jwk instance) => <String, dynamic>{
  'alg': instance.alg,
  'crv': instance.crv,
  'kid': instance.kid,
  'kty': instance.kty,
  'use': instance.use,
  'x': instance.x,
  'y': instance.y,
};
