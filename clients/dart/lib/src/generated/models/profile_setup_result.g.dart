// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'profile_setup_result.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ProfileSetupResult _$ProfileSetupResultFromJson(Map<String, dynamic> json) =>
    ProfileSetupResult(
      circleId: json['circle_id'] as String?,
      locationSharingEnabled: json['location_sharing_enabled'] as bool,
      memberId: json['member_id'] as String?,
      memberStatus: json['member_status'] == null
          ? null
          : ProfileSetupResultMemberStatus.fromJson(
              json['member_status'] as String,
            ),
      profileSetupCompletedAt: json['profile_setup_completed_at'] as String,
    );

Map<String, dynamic> _$ProfileSetupResultToJson(ProfileSetupResult instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'location_sharing_enabled': instance.locationSharingEnabled,
      'member_id': instance.memberId,
      'member_status': instance.memberStatus,
      'profile_setup_completed_at': instance.profileSetupCompletedAt,
    };
