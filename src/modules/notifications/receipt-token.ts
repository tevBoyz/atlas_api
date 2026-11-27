import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ApiConfigService } from '../../config';

/**
 * Stage 2 [B7] (D77): the `receipt_token` data key of every push that has a
 * `notification_deliveries` row. The phone posts it back (`POST /v1/notifications/receipts`, no
 * session) when the push arrives; a valid token names exactly one delivery row.
 *
 * Shape (opaque to the app): `<delivery id, 32 lowercase hex>.<HMAC-SHA256 of "v1:" + id,
 * first 16 bytes, base64url>`. The HMAC key is derived (HKDF-SHA256, info
 * {@link RECEIPT_KEY_INFO}) from `AUTH_JWT_KEYS`, which the API and the worker share (required in
 * production), so no new secret is needed; a different purpose label keeps it separate from the
 * token signing. Without `AUTH_JWT_KEYS` (development and tests only) a fixed development key is
 * used. A token is never logged.
 */
export const RECEIPT_KEY_INFO = 'atlas:notification-receipt:v1';

/** Used only when AUTH_JWT_KEYS is unset (never in production: the config refuses that). */
const DEVELOPMENT_KEY_MATERIAL = 'atlas-development-receipt-key';

const TOKEN = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{22})$/;
const MAC_BYTES = 16;

/** The HMAC key from its secret material. */
export function receiptKey(material: string): Buffer {
  return Buffer.from(hkdfSync('sha256', material, '', RECEIPT_KEY_INFO, 32));
}

function mac(key: Buffer, hexId: string): Buffer {
  return createHmac('sha256', key).update(`v1:${hexId}`).digest().subarray(0, MAC_BYTES);
}

/** The token of delivery row `deliveryId` (a uuid). */
export function signReceiptToken(key: Buffer, deliveryId: string): string {
  const hexId = deliveryId.replace(/-/g, '').toLowerCase();
  return `${hexId}.${mac(key, hexId).toString('base64url')}`;
}

/** The delivery id a token names, or undefined when it is malformed or not signed by `key`. */
export function verifyReceiptToken(key: Buffer, token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  const match = TOKEN.exec(token);
  if (!match) return undefined;
  const [, hexId, signature] = match;
  const given = Buffer.from(signature, 'base64url');
  // Canonical spelling only (the last character also carries 2 unused bits).
  if (given.toString('base64url') !== signature) return undefined;
  const expected = mac(key, hexId);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return `${hexId.slice(0, 8)}-${hexId.slice(8, 12)}-${hexId.slice(12, 16)}-${hexId.slice(16, 20)}-${hexId.slice(20)}`;
}

/** The key of this process, from the configuration. */
@Injectable()
export class ReceiptTokens {
  private readonly key: Buffer;

  constructor(config: ApiConfigService) {
    this.key = receiptKey(config.get('AUTH_JWT_KEYS') ?? DEVELOPMENT_KEY_MATERIAL);
  }

  sign(deliveryId: string): string {
    return signReceiptToken(this.key, deliveryId);
  }

  verify(token: unknown): string | undefined {
    return verifyReceiptToken(this.key, token);
  }
}
