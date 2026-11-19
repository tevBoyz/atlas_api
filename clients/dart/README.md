# atlas_api_client

Dart client for the Atlas API, generated from `../../openapi.json` with
[swagger_parser](https://pub.dev/packages/swagger_parser) (pure Dart, no Java). The package version
is always the API version. Never edit `lib/src/generated` by hand.

From the repository root:

```sh
npm run openapi:generate       # openapi.json from the code
npm run client:dart:generate   # lib/src/generated from openapi.json
npm run client:dart:build      # locked dependencies, dart analyze, dart test
```

## Dependencies

Runtime dependencies (`dio`, `json_annotation`, `retrofit`) use caret ranges so an app can resolve
them alongside its own packages. Generator and test dependencies stay pinned, and `pubspec.lock`
pins what `client:dart:generate` / `client:dart:build` use, so the generated code is byte-stable.

## Unknown enum values

A value the server adds later parses to the enum's `$unknown`. `client:dart:generate` patches the
swagger_parser output (`patchUnknownEnums` in `src/openapi/dart-client.ts`; swagger_parser has no
option for it) so that nothing throws and the value survives a round trip:

- an enum's `toJson()` returns `String?` (null for `$unknown`) instead of throwing;
- a model with an enum field writes each enum field as a string in its `toJson()` map: the string it
  was parsed from (so `Model.fromJson(json).toJson()` keeps `"status": "paused"`), else the enum's
  JSON value. See `lib/src/unknown_enum_values.dart` and `test/unknown_enum_test.dart`.
