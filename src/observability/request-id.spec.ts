import type { IncomingMessage } from 'node:http';

import { genRequestId, resolveRequestId } from './request-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request id (API-100-06 AC1)', () => {
  it.each([
    'abc-123',
    '6f1c2a3e-1d2b-4c5d-8e9f-0a1b2c3d4e5f',
    '01JD3XK5V8Q2M7N9P0R1S2T3U4',
    'Root.1-67891233:abc_def',
    'a'.repeat(128),
  ])('accepts a valid incoming id: %s', (id) => {
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(129)],
    ['spaces', 'abc 123'],
    ['newline (log injection)', 'abc\n{"level":"fatal"}'],
    ['quotes', 'abc"def'],
    ['slash', 'a/b'],
    ['equals sign', 'Root=1-abc'],
  ])('replaces an invalid incoming id (%s) with a UUID', (_label, id) => {
    expect(resolveRequestId(id)).toMatch(UUID_V4);
  });

  it('generates a UUID when the header is missing', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_V4);
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });

  it('uses the first value of a repeated header', () => {
    expect(resolveRequestId(['first-id', 'second-id'])).toBe('first-id');
  });

  it('stores the id on the raw request for pino-http', () => {
    const raw = { headers: { 'x-request-id': 'given-id' } } as unknown as IncomingMessage;
    expect(genRequestId(raw)).toBe('given-id');
    expect((raw as IncomingMessage & { id?: string }).id).toBe('given-id');
  });
});
