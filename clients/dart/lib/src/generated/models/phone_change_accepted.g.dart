// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'phone_change_accepted.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PhoneChangeAccepted _$PhoneChangeAcceptedFromJson(Map<String, dynamic> json) =>
    PhoneChangeAccepted(
      verification: PhoneChangeVerification.fromJson(
        json['verification'] as Map<String, dynamic>,
      ),
    );

Map<String, dynamic> _$PhoneChangeAcceptedToJson(
  PhoneChangeAccepted instance,
) => <String, dynamic>{'verification': instance.verification};
