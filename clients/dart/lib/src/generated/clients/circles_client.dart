// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/capacity.dart';
import '../models/circle_member.dart';
import '../models/own_circle.dart';

part 'circles_client.g.dart';

@RestApi()
abstract class CirclesClient {
  factory CirclesClient(Dio dio, {String? baseUrl}) = _CirclesClient;

  /// Who is in the circle, by their current names
  @GET('/v1/circles/{circle_id}/members')
  Future<List<CircleMember>> listCircleMembers({
    @Path('circle_id') required String circleId,
  });

  /// The circle the caller owns, its members (owner view) and its capacity
  @GET('/v1/me/circle')
  Future<OwnCircle> fetchOwnCircle();

  /// How many trusted-member slots of the circle the caller owns are used and free
  @GET('/v1/me/circle/capacity')
  Future<Capacity> circleInviteCapacity();
}
