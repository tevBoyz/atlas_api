// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'link_invite_request.g.dart';

@JsonSerializable()
class LinkInviteRequest {
  const LinkInviteRequest({this.displayName});

  factory LinkInviteRequest.fromJson(Map<String, Object?> json) =>
      _$LinkInviteRequestFromJson(json);

  /// Missing or blank: `Invited member`.
  @JsonKey(name: 'display_name')
  final String? displayName;

  Map<String, Object?> toJson() => _$LinkInviteRequestToJson(this);
}
