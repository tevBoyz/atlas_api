import { Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';

import { ApiConfigService } from '../../config';
import { ChannelSenders } from '../notifications/channels/channel-senders';
import { FakeEmailSender, FakeSmsSender } from '../notifications/channels/fake-senders';

/** Path of the test-only mailbox (outside `/v1`, not in the OpenAPI document). */
export const TEST_MAILBOX_PATH = '/__test/auth-messages';

export interface MailboxMessage {
  channel: 'email' | 'sms';
  subject: string | null;
  text: string;
}

/** What the FAKE adapters accepted for `to`, oldest first. */
export function mailboxFor(channels: ChannelSenders, to: string): MailboxMessage[] {
  const messages: MailboxMessage[] = [];
  if (channels.email instanceof FakeEmailSender) {
    for (const sent of channels.email.sent) {
      if (sent.to !== to) continue;
      const content = sent.content as { subject: string; text: string };
      messages.push({ channel: 'email', subject: content.subject, text: content.text });
    }
  }
  if (channels.sms instanceof FakeSmsSender) {
    for (const sent of channels.sms.sent) {
      if (sent.to === to)
        messages.push({ channel: 'sms', subject: null, text: String(sent.content) });
    }
  }
  return messages;
}

/**
 * TEST-ONLY seam (Phase 6): `GET /__test/auth-messages?to=<email or +E.164>` answers what the fake
 * email and SMS adapters "sent" to that address (verification and reset links, OTP codes), so the
 * automated tests, the load check and the manual guide can follow a link or type a code. Registered
 * only when AUTH_TEST_MAILBOX_ENABLED=true (refused by the config when NODE_ENV=production) and
 * only for the fake adapters: a real provider's messages never pass through here. No bearer token
 * (like the fake Storage upload route); never cached; nothing is logged but the route template.
 */
@Injectable()
export class TestMailboxRoute implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly channels: ChannelSenders,
    private readonly config: ApiConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('AUTH_TEST_MAILBOX_ENABLED') || this.config.isProduction) return;
    const fastify = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!fastify) return;
    const channels = this.channels;
    fastify.get(TEST_MAILBOX_PATH, async (request, reply) => {
      const to = (request.query as { to?: unknown }).to;
      void reply.header('cache-control', 'no-store');
      if (typeof to !== 'string' || to.length === 0 || to.length > 254) {
        return reply.status(400).send({ messages: [] });
      }
      return reply.status(200).send({ messages: mailboxFor(channels, to) });
    });
  }
}
