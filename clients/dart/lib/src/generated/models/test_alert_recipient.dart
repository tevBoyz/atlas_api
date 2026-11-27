// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'test_alert_failure_reason.dart';
import 'test_alert_member_state.dart';

part 'test_alert_recipient.g.dart';

@JsonSerializable()
class TestAlertRecipient {
  const TestAlertRecipient({
    required this.deliveredAt,
    required this.displayName,
    required this.failureReason,
    required this.handle,
    required this.seenAt,
    required this.status,
  });

  factory TestAlertRecipient.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$TestAlertRecipientFromJson(json), json);

  /// When the push provider first accepted it for one of the member devices.
  @JsonKey(name: 'delivered_at')
  final String? deliveredAt;

  /// The member current profile name (trimmed), else the name on their member row.
  @JsonKey(name: 'display_name')
  final String? displayName;

  /// Set only when `status` is `failed`: `no_device`, `invalid_token`, `provider_error`, `channel_disabled` or `not_eligible`.
  @JsonKey(name: 'failure_reason')
  final TestAlertFailureReason? failureReason;

  /// D79 (replaces user_id): the recipient's member row id in the circle (CircleMember.handle); null once they hold no row there.
  final String? handle;

  /// When the member opened it in Atlas.
  @JsonKey(name: 'seen_at')
  final String? seenAt;
  final TestAlertMemberState status;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$TestAlertRecipientToJson(this));
}
