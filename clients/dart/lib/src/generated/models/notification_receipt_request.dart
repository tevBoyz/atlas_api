// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'notification_receipt_request.g.dart';

@JsonSerializable()
class NotificationReceiptRequest {
  const NotificationReceiptRequest({required this.receiptToken});

  factory NotificationReceiptRequest.fromJson(Map<String, Object?> json) =>
      _$NotificationReceiptRequestFromJson(json);

  /// The `receipt_token` data key of the push, exactly as received (opaque).
  @JsonKey(name: 'receipt_token')
  final String receiptToken;

  Map<String, Object?> toJson() => _$NotificationReceiptRequestToJson(this);
}
