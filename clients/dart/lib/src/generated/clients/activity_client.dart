// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/activity_page.dart';
import '../models/category.dart';

part 'activity_client.g.dart';

@RestApi()
abstract class ActivityClient {
  factory ActivityClient(Dio dio, {String? baseUrl}) = _ActivityClient;

  /// The caller's emergency activity log (My Emergencies and Circle Alerts), newest first
  @GET('/v1/me/activity')
  Future<ActivityPage> listMyActivity({
    @Query('category') Category? category,
    @Query('before') String? before,
    @Query('limit') int? limit,
  });
}
