// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'batch_invite_item.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

BatchInviteItem _$BatchInviteItemFromJson(Map<String, dynamic> json) =>
    BatchInviteItem(
      displayName: json['display_name'] as String,
      phone: json['phone'] as String,
    );

Map<String, dynamic> _$BatchInviteItemToJson(BatchInviteItem instance) =>
    <String, dynamic>{
      'display_name': instance.displayName,
      'phone': instance.phone,
    };
