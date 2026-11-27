import { randomUUID } from 'node:crypto';

import { receiptKey, signReceiptToken, verifyReceiptToken } from './receipt-token';

describe('receipt token (Stage 2 [B7], D77)', () => {
  const key = receiptKey('material-a');
  const id = randomUUID();

  it('names its delivery row and verifies with the same key', () => {
    const token = signReceiptToken(key, id);
    expect(token).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
    expect(verifyReceiptToken(key, token)).toBe(id);
    expect(signReceiptToken(key, id)).toBe(token);
  });

  it('refuses a token of another key, a changed id or signature, and malformed input', () => {
    const token = signReceiptToken(key, id);
    expect(verifyReceiptToken(receiptKey('material-b'), token)).toBeUndefined();
    const [hexId, mac] = token.split('.');
    const otherId = `${hexId.slice(0, 31)}${hexId.endsWith('0') ? '1' : '0'}`;
    expect(verifyReceiptToken(key, `${otherId}.${mac}`)).toBeUndefined();
    const otherMac = `${mac.startsWith('A') ? 'B' : 'A'}${mac.slice(1)}`;
    expect(verifyReceiptToken(key, `${hexId}.${otherMac}`)).toBeUndefined();
    for (const bad of [undefined, null, 42, '', 'x.y', `${hexId}.`, `${token}x`, { token }]) {
      expect(verifyReceiptToken(key, bad)).toBeUndefined();
    }
  });

  it('the key is derived for this purpose: not the material itself', () => {
    expect(key.equals(Buffer.from('material-a'))).toBe(false);
    expect(key).toHaveLength(32);
  });
});
