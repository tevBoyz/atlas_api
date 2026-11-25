// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'package:atlas_api_client/src/unknown_enum_values.dart';

import 'responder_delivery_failed_reason.dart';
import 'responder_delivery_status.dart';
import 'responder_status.dart';

part 'responder.g.dart';

@JsonSerializable()
class Responder {
  const Responder({
    required this.acknowledgedAt,
    required this.avatarUrl,
    required this.displayName,
    required this.isMe,
    required this.status,
    required this.statusAt,
    required this.userId,
    this.deliveryAt,
    this.deliveryFailedReason,
    this.deliveryStatus,
  });

  factory Responder.fromJson(Map<String, Object?> json) =>
      keepRawJson(_$ResponderFromJson(json), json);

  /// When the member acknowledged (also set by their first response); null if not.
  @JsonKey(name: 'acknowledged_at')
  final String? acknowledgedAt;

  /// Public URL of the member's profile photo, as in the circle member list; null without one.
  @JsonKey(name: 'avatar_url')
  final String? avatarUrl;

  /// RESIDENT ONLY (D73): delivered = the first acceptance; failed = when the last attempt became final (null when nothing was ever sent); sent = null.
  @JsonKey(name: 'delivery_at')
  final String? deliveryAt;

  /// RESIDENT ONLY (D73): failed = the push service did not accept it after the retries; no_device = nothing could be sent (no device with notifications or push switched off); null unless delivery_status is failed.
  @JsonKey(name: 'delivery_failed_reason')
  final ResponderDeliveryFailedReason? deliveryFailedReason;

  /// RESIDENT ONLY (SCRUM-65, D73; absent on a member's rows): the alert's delivery to this member. delivered = the push service accepted the alert (or a re-notify) for at least one of their devices; sent = still being sent or retried; failed = every attempt failed after its retries, or nothing could be sent (no device with notifications, push switched off). A re-notify recomputes it (failed can become delivered).
  @JsonKey(name: 'delivery_status')
  final ResponderDeliveryStatus? deliveryStatus;

  /// The member's profile name (trimmed), else the name stored on their membership.
  @JsonKey(name: 'display_name')
  final String displayName;

  /// True on the caller's own row.
  @JsonKey(name: 'is_me')
  final bool isMe;

  /// responding / unable: the member's response; acknowledged: seen, no response yet; no_response: not acknowledged.
  final ResponderStatus status;

  /// When the current status was set: the response time for responding / unable, the acknowledge time for acknowledged, null for no_response.
  @JsonKey(name: 'status_at')
  final String? statusAt;

  /// The member. The resident gets the full UUID. A member gets the ids of other members obscured as incident event actor ids (D11): the first 4 and the last 4 hex characters kept, every other hex character "*", hyphens kept (e.g. "4f3a****-****-****-****-********9c2d"); their own id in full. Not a usable UUID when obscured.
  @JsonKey(name: 'user_id')
  final String userId;

  Map<String, Object?> toJson() =>
      enumValuesAsStrings(this, _$ResponderToJson(this));
}
