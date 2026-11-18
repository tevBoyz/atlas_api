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
