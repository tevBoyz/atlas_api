// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'responder.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Responder _$ResponderFromJson(Map<String, dynamic> json) => Responder(
  acknowledgedAt: json['acknowledged_at'] as String?,
  avatarUrl: json['avatar_url'] as String?,
  displayName: json['display_name'] as String,
  isMe: json['is_me'] as bool,
  status: ResponderStatus.fromJson(json['status'] as String),
  statusAt: json['status_at'] as String?,
  userId: json['user_id'] as String,
  deliveryAt: json['delivery_at'] as String?,
  deliveryFailedReason: json['delivery_failed_reason'] == null
      ? null
      : ResponderDeliveryFailedReason.fromJson(
          json['delivery_failed_reason'] as String,
        ),
  deliveryStatus: json['delivery_status'] == null
      ? null
      : ResponderDeliveryStatus.fromJson(json['delivery_status'] as String),
);

Map<String, dynamic> _$ResponderToJson(Responder instance) => <String, dynamic>{
  'acknowledged_at': instance.acknowledgedAt,
  'avatar_url': instance.avatarUrl,
  'delivery_at': instance.deliveryAt,
  'delivery_failed_reason': instance.deliveryFailedReason,
  'delivery_status': instance.deliveryStatus,
  'display_name': instance.displayName,
  'is_me': instance.isMe,
  'status': instance.status,
  'status_at': instance.statusAt,
  'user_id': instance.userId,
};
