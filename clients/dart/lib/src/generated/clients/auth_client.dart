// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/apple_sign_in_request.dart';
import '../models/device_session.dart';
import '../models/email_resend_request.dart';
import '../models/email_verify_request.dart';
import '../models/google_sign_in_request.dart';
import '../models/jwks.dart';
import '../models/lockout_status.dart';
import '../models/login_request.dart';
import '../models/o_auth_session.dart';
import '../models/otp_send_request.dart';
import '../models/otp_sent.dart';
import '../models/otp_verified.dart';
import '../models/otp_verify_request.dart';
import '../models/password_change_request.dart';
import '../models/password_forgot_request.dart';
import '../models/password_reset_request.dart';
import '../models/phone_change_accepted.dart';
import '../models/phone_change_request.dart';
import '../models/phone_change_verify_request.dart';
import '../models/phone_changed.dart';
import '../models/refresh_request.dart';
import '../models/session.dart';
import '../models/signup_accepted.dart';
import '../models/signup_request.dart';
import '../models/user.dart';

part 'auth_client.g.dart';

@RestApi()
abstract class AuthClient {
  factory AuthClient(Dio dio, {String? baseUrl}) = _AuthClient;

  /// Public keys that verify the API access tokens (JWKS)
  @GET('/v1/auth/.well-known/jwks.json')
  Future<Jwks> getAuthJwks();

  /// Email a new confirmation link (signup) or a sign-in link (magic_link)
  @POST('/v1/auth/email/resend')
  Future<void> resendEmail({@Body() required EmailResendRequest body});

  /// Confirm the email with the link token and sign in.
  ///
  /// [xAtlasInstallationId] - The app installation id (the same UUID as for `PUT /v1/me/devices/current`). Links the new session to that device, so signing out clears its push token.
  @POST('/v1/auth/email/verify')
  Future<Session> verifyEmail({
    @Body() required EmailVerifyRequest body,
    @Header('X-Atlas-Installation-Id') String? xAtlasInstallationId,
  });

  /// Is this email / phone locked, and until when (for the sign-in screen)
  @GET('/v1/auth/lockout-status')
  Future<LockoutStatus> loginLockoutStatus({
    @Query('email') String? email,
    @Query('phone') String? phone,
  });

  /// Sign in with email or phone and password (with the 5 / 15 min lockout).
  ///
  /// [xAtlasInstallationId] - The app installation id (the same UUID as for `PUT /v1/me/devices/current`). Links the new session to that device, so signing out clears its push token.
  @POST('/v1/auth/login')
  Future<Session> signInWithPassword({
    @Body() required LoginRequest body,
    @Header('X-Atlas-Installation-Id') String? xAtlasInstallationId,
  });

  /// End this device's session (and clear its push token)
  @POST('/v1/auth/logout')
  Future<void> signOut();

  /// End every session of my account on every device
  @POST('/v1/auth/logout-all')
  Future<void> signOutEverywhere();

  /// Sign in with an Apple ID token (off until enabled: 503 auth:provider_disabled).
  ///
  /// [xAtlasInstallationId] - The app installation id (the same UUID as for `PUT /v1/me/devices/current`). Links the new session to that device, so signing out clears its push token.
  @POST('/v1/auth/oauth/apple')
  Future<OAuthSession> signInWithApple({
    @Body() required AppleSignInRequest body,
    @Header('X-Atlas-Installation-Id') String? xAtlasInstallationId,
  });

  /// Sign in with a Google ID token.
  ///
  /// [xAtlasInstallationId] - The app installation id (the same UUID as for `PUT /v1/me/devices/current`). Links the new session to that device, so signing out clears its push token.
  @POST('/v1/auth/oauth/google')
  Future<OAuthSession> signInWithGoogle({
    @Body() required GoogleSignInRequest body,
    @Header('X-Atlas-Installation-Id') String? xAtlasInstallationId,
  });

  /// Text a new code (resets the failed attempts)
  @POST('/v1/auth/otp/resend')
  Future<OtpSent> resendOtp({@Body() required OtpSendRequest body});

  /// Text a 6-digit code to a phone (sign in, or verify my own number)
  @POST('/v1/auth/otp/send')
  Future<OtpSent> sendOtp({@Body() required OtpSendRequest body});

  /// Check a texted code: sign in (Session) or confirm my number ({user}).
  ///
  /// [xAtlasInstallationId] - The app installation id (the same UUID as for `PUT /v1/me/devices/current`). Links the new session to that device, so signing out clears its push token.
  @POST('/v1/auth/otp/verify')
  Future<OtpVerified> verifyOtp({
    @Body() required OtpVerifyRequest body,
    @Header('X-Atlas-Installation-Id') String? xAtlasInstallationId,
  });

  /// Change my password (current password required); my other devices are signed out
  @PUT('/v1/auth/password')
  Future<void> changePassword({@Body() required PasswordChangeRequest body});

  /// Email a password reset link (type=recovery)
  @POST('/v1/auth/password/forgot')
  Future<void> forgotPassword({@Body() required PasswordForgotRequest body});

  /// Set a new password with the recovery link token and sign in.
  ///
  /// [xAtlasInstallationId] - The app installation id (the same UUID as for `PUT /v1/me/devices/current`). Links the new session to that device, so signing out clears its push token.
  @POST('/v1/auth/password/reset')
  Future<Session> resetPassword({
    @Body() required PasswordResetRequest body,
    @Header('X-Atlas-Installation-Id') String? xAtlasInstallationId,
  });

  /// Exchange the refresh token for a new session (the old refresh token is used up)
  @POST('/v1/auth/refresh')
  Future<Session> refreshSession({@Body() required RefreshRequest body});

  /// Create an account (email or phone, password, name); a link is emailed and/or a code texted.
  ///
  /// [xAtlasInstallationId] - The app installation id (the same UUID as for `PUT /v1/me/devices/current`). Links the new session to that device, so signing out clears its push token.
  @POST('/v1/auth/signup')
  Future<SignupAccepted> signUp({
    @Body() required SignupRequest body,
    @Header('X-Atlas-Installation-Id') String? xAtlasInstallationId,
  });

  /// My account: email, phone, confirmations and sign-in methods
  @GET('/v1/me')
  Future<User> getCurrentUser();

  /// Text a code to my new phone number (the number changes only once it is verified)
  @PUT('/v1/me/phone')
  Future<PhoneChangeAccepted> changePhone({
    @Body() required PhoneChangeRequest body,
  });

  /// Verify the code texted to my new phone number; the number becomes my confirmed phone
  @POST('/v1/me/phone/verify')
  Future<PhoneChanged> verifyPhoneChange({
    @Body() required PhoneChangeVerifyRequest body,
  });

  /// My signed-in devices (sessions), most recently used first
  @GET('/v1/me/sessions')
  Future<List<DeviceSession>> listMySessions();

  /// Sign out one of my devices
  @DELETE('/v1/me/sessions/{session_id}')
  Future<void> endMySession({@Path('session_id') required String sessionId});
}
