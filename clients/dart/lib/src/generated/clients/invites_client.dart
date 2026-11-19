// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/batch_invite_request.dart';
import '../models/batch_invite_result.dart';
import '../models/canceled_invite.dart';
import '../models/link_invite_request.dart';
import '../models/member_invite_payload.dart';
import '../models/phone_invite_request.dart';

part 'invites_client.g.dart';

@RestApi()
abstract class InvitesClient {
  factory InvitesClient(Dio dio, {String? baseUrl}) = _InvitesClient;

  /// Create a single-use invitation link (reserves one slot).
  ///
  /// [idempotencyKey] - UUID chosen by the client. A retry with the same key replays the first result.
  @POST('/v1/me/circle/invites/link')
  Future<MemberInvitePayload> createCircleInviteLink({
    @Body() required LinkInviteRequest body,
    @Header('Idempotency-Key') String? idempotencyKey,
  });

  /// Invite one person by phone, or refresh the invitation of that phone.
  ///
  /// [idempotencyKey] - UUID chosen by the client. A retry with the same key replays the first result.
  @POST('/v1/me/circle/invites/phone')
  Future<MemberInvitePayload> inviteCircleMemberByPhone({
    @Body() required PhoneInviteRequest body,
    @Header('Idempotency-Key') String? idempotencyKey,
  });

  /// Invite several people by phone in one go, with an outcome per person.
  ///
  /// [idempotencyKey] - UUID chosen by the client. A retry with the same key replays the first result.
  @POST('/v1/me/circle/invites/phone/batch')
  Future<BatchInviteResult> inviteCircleMembersByPhone({
    @Body() required BatchInviteRequest body,
    @Header('Idempotency-Key') String? idempotencyKey,
  });

  /// Cancel a pending or expired invitation and free its place
  @POST('/v1/me/circle/invites/{member_id}/cancel')
  Future<CanceledInvite> cancelCircleInvite({
    @Path('member_id') required String memberId,
  });

  /// Resend a pending, expired or declined invitation with a new token
  @POST('/v1/me/circle/invites/{member_id}/resend')
  Future<MemberInvitePayload> resendCircleInvite({
    @Path('member_id') required String memberId,
  });
}
