// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'signup_accepted.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SignupAccepted _$SignupAcceptedFromJson(Map<String, dynamic> json) =>
    SignupAccepted(
      verification: Verification.fromJson(
        json['verification'] as Map<String, dynamic>,
      ),
      verifications: (json['verifications'] as List<dynamic>)
          .map((e) => SignupVerification.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$SignupAcceptedToJson(SignupAccepted instance) =>
    <String, dynamic>{
      'verification': instance.verification,
      'verifications': instance.verifications,
    };
