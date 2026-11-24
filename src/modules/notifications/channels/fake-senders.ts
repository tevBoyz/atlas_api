import { randomUUID } from 'node:crypto';

import type {
  EmailSender,
  PushNotice,
  PushSender,
  PushTarget,
  SendResult,
  SmsSender,
} from './channel.types';
import { failed } from './channel.types';
import { pushText } from './push-content';

/**
 * Token prefixes the fake push adapter treats specially (tests and the manual guide; the fake is
 * never used in production, D24): `fake-fail-…` fails every time as a transient error
 * (`fake_unavailable`, retried, then `failed`); `fake-unregistered-…` answers `unregistered` (the
 * token is cleared). Any other token is `sent`.
 */
export const FAKE_FAIL_TOKEN_PREFIX = 'fake-fail-';
export const FAKE_UNREGISTERED_TOKEN_PREFIX = 'fake-unregistered-';

/** One message a fake adapter accepted (kept in memory, for tests). */
export interface FakeSent<T> {
  provider_message_id: string;
  to: T;
  content: unknown;
  /** Push only: the visible title and body the real adapters would send (D54). */
  text?: { title: string; body: string };
}

const sentId = () => `fake-${randomUUID()}`;

/** A long-running local worker keeps only the latest messages in memory. */
export const FAKE_MEMORY_LIMIT = 10_000;

function remember<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > FAKE_MEMORY_LIMIT) list.splice(0, list.length - FAKE_MEMORY_LIMIT);
}

/** In-process push adapter (AC2): nothing leaves the process. */
export class FakePushSender implements PushSender {
  readonly sent: FakeSent<PushTarget>[] = [];
  /** Every call, including failed ones (tests count attempts). */
  readonly calls: PushTarget[] = [];

  send(target: PushTarget, message: PushNotice): Promise<SendResult> {
    remember(this.calls, target);
    if (target.token.startsWith(FAKE_FAIL_TOKEN_PREFIX)) {
      return Promise.resolve(failed('fake_unavailable'));
    }
    if (target.token.startsWith(FAKE_UNREGISTERED_TOKEN_PREFIX)) {
      return Promise.resolve(failed('unregistered'));
    }
    const id = sentId();
    remember(this.sent, {
      provider_message_id: id,
      to: target,
      content: message,
      text: pushText(message, target.time_zone),
    });
    return Promise.resolve({ provider_message_id: id, status: 'sent' });
  }
}

/** In-process SMS adapter (AC2, AC4): the default; never reaches Twilio. */
export class FakeSmsSender implements SmsSender {
  readonly sent: FakeSent<string>[] = [];

  send(to: string, text: string): Promise<SendResult> {
    const id = sentId();
    remember(this.sent, { provider_message_id: id, to, content: text });
    return Promise.resolve({ provider_message_id: id, status: 'sent' });
  }
}

/** In-process email adapter (AC2): the default; SendGrid only with CHANNEL_EMAIL_ADAPTER=sendgrid (D43). */
export class FakeEmailSender implements EmailSender {
  readonly sent: FakeSent<string>[] = [];

  send(to: string, subject: string, text: string): Promise<SendResult> {
    const id = sentId();
    remember(this.sent, { provider_message_id: id, to, content: { subject, text } });
    return Promise.resolve({ provider_message_id: id, status: 'sent' });
  }
}
