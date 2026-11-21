// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'jwk.dart';

part 'jwks.g.dart';

@JsonSerializable()
class Jwks {
  const Jwks({required this.keys});

  factory Jwks.fromJson(Map<String, Object?> json) => _$JwksFromJson(json);

  final List<Jwk> keys;

  Map<String, Object?> toJson() => _$JwksToJson(this);
}
