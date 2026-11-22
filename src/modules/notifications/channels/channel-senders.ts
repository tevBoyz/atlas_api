import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Logger } from 'pino';

import { ApiConfigService } from '../../../config';
import { ROOT_LOGGER } from '../../../observability/logger';
import type { Channel, EmailSender, PushSender, SmsSender } from './channel.types';
import { FakeEmailSender, FakePushSender, FakeSmsSender } from './fake-senders';
import { FetchTransport, Http2Transport } from './http-transport';
import {
  ApnsPushSender,
  FcmPushSender,
  RoutingPushSender,
  SendGridEmailSender,
  TwilioSmsSender,
} from './real-senders';

/**
 * The channel adapters of this process (API-100-46, D24), chosen from the config once at startup:
 *
 * | Channel | Adapter (default `fake`)                                   | Sends only when            |
 * | ------- | ---------------------------------------------------------- | -------------------------- |
 * | push    | `fake`, or `real` = FCM and/or APNs with their keys        | CHANNEL_PUSH_ENABLED=true  |
 * | sms     | `fake`, or `twilio` (refused while the Twilio hold is on)  | CHANNEL_SMS_ENABLED=true   |
 * | email   | `fake`, or `sendgrid` with its key and sender (D43)        | CHANNEL_EMAIL_ENABLED=true |
 *
 * A disabled channel calls no adapter: its deliveries are recorded `skipped` (API-100-47). Every
 * email (the auth links of AuthMessenger and the notification emails) goes through `email`.
 */
@Injectable()
export class ChannelSenders implements OnModuleDestroy {
  readonly push: PushSender;
  readonly sms: SmsSender;
  readonly email: EmailSender;
  private readonly enabled: Readonly<Record<Channel, boolean>>;
  private readonly http2?: Http2Transport;

  constructor(config: ApiConfigService, @Inject(ROOT_LOGGER) logger: Logger) {
    this.enabled = {
      push: config.get('CHANNEL_PUSH_ENABLED'),
      sms: config.get('CHANNEL_SMS_ENABLED'),
      email: config.get('CHANNEL_EMAIL_ENABLED'),
    };
    const timeoutMs = config.get('NOTIFICATIONS_SEND_TIMEOUT_MS');

    if (config.get('CHANNEL_PUSH_ADAPTER') === 'real') {
      const projectId = config.get('FCM_PROJECT_ID');
      const clientEmail = config.get('FCM_CLIENT_EMAIL');
      const fcmKey = config.get('FCM_PRIVATE_KEY');
      const keyId = config.get('APNS_KEY_ID');
      const teamId = config.get('APNS_TEAM_ID');
      const apnsKey = config.get('APNS_PRIVATE_KEY');
      const bundleId = config.get('APNS_BUNDLE_ID');
      if (keyId && teamId && apnsKey && bundleId) this.http2 = new Http2Transport(timeoutMs);
      this.push = new RoutingPushSender({
        fcm:
          projectId && clientEmail && fcmKey
            ? new FcmPushSender(
                { projectId, clientEmail, privateKey: fcmKey },
                new FetchTransport(timeoutMs),
              )
            : undefined,
        apns: this.http2
          ? new ApnsPushSender(
              {
                keyId: keyId!,
                teamId: teamId!,
                privateKey: apnsKey!,
                bundleId: bundleId!,
                environment: config.get('APNS_ENVIRONMENT'),
              },
              this.http2,
            )
          : undefined,
      });
    } else {
      this.push = new FakePushSender();
    }

    const sid = config.get('TWILIO_ACCOUNT_SID');
    const authToken = config.get('TWILIO_AUTH_TOKEN');
    const from = config.get('TWILIO_FROM_NUMBER');
    // The config refuses `twilio` while the hold is on (CHANNEL_SMS_TWILIO_HOLD_LIFTED); checked
    // again here so that no code path can build the real adapter during the hold.
    this.sms =
      config.get('CHANNEL_SMS_ADAPTER') === 'twilio' &&
      config.get('CHANNEL_SMS_TWILIO_HOLD_LIFTED') &&
      sid &&
      authToken &&
      from
        ? new TwilioSmsSender({ accountSid: sid, authToken, from }, new FetchTransport(timeoutMs))
        : new FakeSmsSender();
    const sendgridKey = config.get('SENDGRID_API_KEY');
    const fromAddress = config.get('EMAIL_FROM_ADDRESS');
    // The config refuses `sendgrid` without its key and sender; checked again here.
    this.email =
      config.get('CHANNEL_EMAIL_ADAPTER') === 'sendgrid' && sendgridKey && fromAddress
        ? new SendGridEmailSender(
            {
              apiKey: sendgridKey,
              baseUrl: config.get('SENDGRID_API_BASE_URL'),
              fromAddress,
              fromName: config.get('EMAIL_FROM_NAME'),
            },
            new FetchTransport(timeoutMs),
          )
        : new FakeEmailSender();

    // Plain strings: the log scrubber masks any key named like `email`.
    const push = this.push instanceof FakePushSender ? 'fake' : 'real';
    const sms = this.sms instanceof FakeSmsSender ? 'fake' : 'twilio';
    const mail = this.email instanceof FakeEmailSender ? 'fake' : 'sendgrid';
    logger.info(
      {
        channels_enabled: `push=${this.enabled.push},sms=${this.enabled.sms},mail=${this.enabled.email}`,
        adapters: `push=${push},sms=${sms},mail=${mail}`,
      },
      'notification channels',
    );
  }

  isEnabled(channel: Channel): boolean {
    return this.enabled[channel];
  }

  onModuleDestroy(): void {
    this.http2?.close();
  }
}
