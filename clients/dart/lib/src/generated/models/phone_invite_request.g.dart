// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'phone_invite_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PhoneInviteRequest _$PhoneInviteRequestFromJson(Map<String, dynamic> json) =>
    PhoneInviteRequest(
      displayName: json['display_name'] as String,
      phone: json['phone'] as String,
      relationship: json['relationship'] == null
          ? null
          : PhoneInviteRequestRelationship.fromJson(
              json['relationship'] as String,
            ),
    );

Map<String, dynamic> _$PhoneInviteRequestToJson(PhoneInviteRequest instance) =>
    <String, dynamic>{
      'display_name': instance.displayName,
      'phone': instance.phone,
      'relationship': instance.relationship,
    };
