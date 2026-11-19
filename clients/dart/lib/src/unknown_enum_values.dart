/// Enum fields of generated models serialize to their JSON strings, and unknown values round-trip.
///
/// swagger_parser maps a value the client does not know (one the server added later) to the enum's
/// `$unknown`, which has no JSON value, and json_serializable leaves enum objects in the map a
/// model's `toJson()` returns. `npm run client:dart:generate` adds a post-generation step
/// (src/openapi/dart-client.ts, `patchUnknownEnums`) so that:
/// - an enum's `toJson()` returns `String?` (null for `$unknown`) instead of throwing, and
/// - every generated model with an enum field remembers the string values it was parsed from
///   ([keepRawJson]), and its `toJson()` writes each enum field as a string ([enumValuesAsStrings]):
///   the original string for a model parsed from JSON, otherwise the enum's JSON value.
///
/// So `Model.fromJson(json).toJson()` equals `json` for enum fields, including a new server value
/// such as `"status": "paused"`. Known values keep their stored strings.
library;

final Expando<Map<String, String>> _rawStrings = Expando('atlasRawStrings');

/// Remembers the string values of [json] for [model] (called by the generated `fromJson`).
T keepRawJson<T extends Object>(T model, Map<String, Object?> json) {
  final strings = <String, String>{
    for (final MapEntry(:key, :value) in json.entries)
      if (value is String) key: value,
  };
  if (strings.isNotEmpty) _rawStrings[model] = strings;
  return model;
}

/// Replaces each enum object in [out] (the result of the generated `toJson` of [model]) with a
/// string: the one [model] was parsed from when there is one (so `$unknown` keeps the server's
/// value), else the enum's own JSON value (null only for a hand-made `$unknown`).
Map<String, Object?> enumValuesAsStrings(
  Object model,
  Map<String, Object?> out,
) {
  final strings = _rawStrings[model];
  for (final MapEntry(:key, :value) in out.entries.toList()) {
    if (value is! Enum) continue;
    // Every generated enum has `String? toJson()`.
    out[key] = strings?[key] ?? (value as dynamic).toJson() as String?;
  }
  return out;
}
