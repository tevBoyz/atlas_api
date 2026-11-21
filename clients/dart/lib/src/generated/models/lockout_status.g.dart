// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'lockout_status.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LockoutStatus _$LockoutStatusFromJson(Map<String, dynamic> json) =>
    LockoutStatus(
      failedAttempts: (json['failed_attempts'] as num).toInt(),
      locked: json['locked'] as bool,
      lockedUntil: json['locked_until'] as String?,
    );

Map<String, dynamic> _$LockoutStatusToJson(LockoutStatus instance) =>
    <String, dynamic>{
      'failed_attempts': instance.failedAttempts,
      'locked': instance.locked,
      'locked_until': instance.lockedUntil,
    };
