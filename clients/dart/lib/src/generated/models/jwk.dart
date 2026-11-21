// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'jwk_alg.dart';

part 'jwk.g.dart';

@JsonSerializable()
class Jwk {
  const Jwk({
    required this.alg,
    required this.crv,
    required this.kid,
    required this.kty,
    required this.use,
    required this.x,
    this.y,
  });

  factory Jwk.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$JwkFromJson(json), json);

  final JwkAlg alg;
  final String crv;
  final String kid;
  final String kty;
  final String use;
  final String x;
  final String? y;

  Map<String, Object?> toJson() => enumValuesAsStrings(this, _$JwkToJson(this));
}
