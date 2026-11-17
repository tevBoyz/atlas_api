import * as Sentry from '@sentry/node';

import { isErrorReportingEnabled, reportError } from './error-reporter';
import { initSentry, scrubBreadcrumb, scrubSentryEvent } from './sentry';

const PHONE = '+12015550177';
/** Fake JWT-shaped value, assembled at runtime so secret scanners do not flag the source. */
const TOKEN = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJTRU5UUlkifQ', 'ZmFrZS1zZW50cnktc2ln'].join('.');

describe('Sentry (API-100-06 AC4)', () => {
  it('is not initialized unless initSentry runs (SENTRY_DSN unset → instrument never calls it)', () => {
    expect(Sentry.getClient()).toBeUndefined();
    expect(isErrorReportingEnabled()).toBe(false);
  });

  it('scrubs events: message, extras and request data', () => {
    const event = scrubSentryEvent({
      type: undefined,
      message: `failed for ${PHONE}`,
      exception: { values: [{ type: 'Error', value: `Bearer ${TOKEN}` }] },
      request: {
        method: 'POST',
        url: `https://api.example.test/v1/invites/abcdefghijklmnop?phone=${PHONE}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        data: { phone: PHONE },
        cookies: { sb: TOKEN },
        query_string: `phone=${PHONE}`,
      },
      user: { id: 'user-1', email: 'ada@example.test', ip_address: '10.0.0.1' },
      extra: { emergency_contact_phone: PHONE, location_lat: 13.4 },
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('ada@example.test');
    expect(text).not.toContain('10.0.0.1');
    expect(text).not.toContain('13.4');
    expect(event.request).toEqual({ method: 'POST' });
    expect(event.user).toEqual({ id: 'user-1' });
  });

  it('drops console breadcrumbs and scrubs the rest', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'http', data: { url: `/v1/x?t=${TOKEN}` } })).toEqual({
      category: 'http',
      data: { url: '/v1/x?t=[REDACTED]' },
    });
  });

  it('when enabled, reports with release + request id and sends nothing unscrubbed (fake transport)', async () => {
    const envelopes: string[] = [];
    const handle = initSentry(
      {
        dsn: 'https://public@sentry.example.invalid/1',
        release: 'abc1234',
        environment: 'test',
      },
      {
        // Fake transport: nothing leaves the process.
        transport: () => ({
          send: (envelope) => {
            envelopes.push(JSON.stringify(envelope));
            return Promise.resolve({});
          },
          flush: () => Promise.resolve(true),
        }),
        integrations: [],
        defaultIntegrations: false,
      },
    );
    try {
      expect(isErrorReportingEnabled()).toBe(true);
      reportError(new Error(`db failed for ${PHONE} with Bearer ${TOKEN}`), {
        request_id: 'req-sentry-1',
        route: '/v1/incidents/:id',
      });
      await Sentry.flush(2000);
      const text = envelopes.join('\n');
      expect(text).toContain('req-sentry-1');
      expect(text).toContain('abc1234');
      expect(text).toContain('db failed for ***77');
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(TOKEN);
    } finally {
      await handle.close();
    }
    expect(isErrorReportingEnabled()).toBe(false);
  });
});
