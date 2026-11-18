// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'readiness_unavailable.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ReadinessUnavailable _$ReadinessUnavailableFromJson(
  Map<String, dynamic> json,
) => ReadinessUnavailable(
  failed: (json['failed'] as List<dynamic>)
      .map((e) => ReadinessUnavailableFailed.fromJson(e as String))
      .toList(),
  status: json['status'] as String,
);

Map<String, dynamic> _$ReadinessUnavailableToJson(
  ReadinessUnavailable instance,
) => <String, dynamic>{'failed': instance.failed, 'status': instance.status};
