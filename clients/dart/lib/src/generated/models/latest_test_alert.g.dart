// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'latest_test_alert.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LatestTestAlert _$LatestTestAlertFromJson(Map<String, dynamic> json) =>
    LatestTestAlert(
      testAlert: json['test_alert'] == null
          ? null
          : TestAlertStatus.fromJson(
              json['test_alert'] as Map<String, dynamic>,
            ),
    );

Map<String, dynamic> _$LatestTestAlertToJson(LatestTestAlert instance) =>
    <String, dynamic>{'test_alert': instance.testAlert};
