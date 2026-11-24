// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/capacity.dart';
import '../models/circle_member.dart';
import '../models/joined_circle.dart';
import '../models/latest_test_alert.dart';
import '../models/left_circle.dart';
import '../models/member_test_alert.dart';
import '../models/own_circle.dart';
import '../models/removed_member.dart';
import '../models/test_alert_sent.dart';
import '../models/test_alert_status.dart';

part 'circles_client.g.dart';

@RestApi()
abstract class CirclesClient {
  factory CirclesClient(Dio dio, {String? baseUrl}) = _CirclesClient;

  /// Leave a circle I am a member of (access ends at once)
  @POST('/v1/circles/{circle_id}/leave')
  Future<LeftCircle> leaveSafetyCircle({
    @Path('circle_id') required String circleId,
  });

  /// Who is in the circle, by their current names
  @GET('/v1/circles/{circle_id}/members')
  Future<List<CircleMember>> listCircleMembers({
    @Path('circle_id') required String circleId,
  });

  /// Remove a member or invitation from the circle I own (access ends at once)
  @DELETE('/v1/circles/{circle_id}/members/{member_id}')
  Future<RemovedMember> removeCircleMember({
    @Path('circle_id') required String circleId,
    @Path('member_id') required String memberId,
  });

  /// The circle the caller owns, its members (owner view) and its capacity
  @GET('/v1/me/circle')
  Future<OwnCircle> fetchOwnCircle();

  /// How many trusted-member slots of the circle the caller owns are used and free
  @GET('/v1/me/circle/capacity')
  Future<Capacity> circleInviteCapacity();

  /// Send a test alert (TEST ALERT — NOT AN EMERGENCY) to the active members of my circle.
  ///
  /// [idempotencyKey] - UUID chosen by the client. A retry with the same key replays the first result.
  @POST('/v1/me/circle/test-alerts')
  Future<TestAlertSent> sendCircleTestAlert({
    @Header('Idempotency-Key') required String idempotencyKey,
  });

  /// The status of my latest test alert
  @GET('/v1/me/circle/test-alerts/latest')
  Future<LatestTestAlert> latestCircleTestAlert();

  /// The delivery status of one of my test alerts, per member
  @GET('/v1/me/circle/test-alerts/{id}')
  Future<TestAlertStatus> getCircleTestAlertStatus({
    @Path('id') required String id,
  });

  /// The circles the caller is an active member of (the own circle included)
  @GET('/v1/me/joined-circles')
  Future<List<JoinedCircle>> listMyJoinedCircles();

  /// A test alert I received (who sent it and when; never an emergency)
  @GET('/v1/test-alerts/{id}')
  Future<MemberTestAlert> getTestAlert({@Path('id') required String id});

  /// Mark a test alert I received as seen (idempotent)
  @POST('/v1/test-alerts/{id}/seen')
  Future<MemberTestAlert> markTestAlertSeen({@Path('id') required String id});
}
