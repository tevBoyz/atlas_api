// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'left_circle.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LeftCircle _$LeftCircleFromJson(Map<String, dynamic> json) => LeftCircle(
  circleId: json['circle_id'] as String,
  left: json['left'] as bool,
  memberId: json['member_id'] as String,
);

Map<String, dynamic> _$LeftCircleToJson(LeftCircle instance) =>
    <String, dynamic>{
      'circle_id': instance.circleId,
      'left': instance.left,
      'member_id': instance.memberId,
    };
