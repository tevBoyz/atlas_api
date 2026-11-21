// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

@JsonEnum()
enum IdentityProvider {
  @JsonValue('email')
  email('email'),
  @JsonValue('phone')
  phone('phone'),
  @JsonValue('google')
  google('google'),
  @JsonValue('apple')
  apple('apple'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const IdentityProvider(this.json);

  factory IdentityProvider.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;
  String? toJson() => json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<IdentityProvider> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
