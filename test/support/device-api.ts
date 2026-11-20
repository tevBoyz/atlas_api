import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { authHeader } from '../../src/testing/test-tokens';

/** `PUT /v1/me/devices/current` (U1) as `userId`. `installationId` undefined = no header. */
export async function registerDevice(
  app: NestFastifyApplication,
  userId: string,
  installationId: string | undefined,
  body: unknown,
) {
  return app.inject({
    method: 'PUT',
    url: '/v1/me/devices/current',
    headers: {
      ...(await authHeader(userId)),
      ...(installationId === undefined ? {} : { 'x-atlas-installation-id': installationId }),
      'content-type': 'application/json',
    },
    payload: JSON.stringify(body),
  });
}

/** `DELETE /v1/me/devices/current/push-token` (U2) as `userId`. */
export async function clearDevicePushToken(
  app: NestFastifyApplication,
  userId: string,
  installationId: string | undefined,
) {
  return app.inject({
    method: 'DELETE',
    url: '/v1/me/devices/current/push-token',
    headers: {
      ...(await authHeader(userId)),
      ...(installationId === undefined ? {} : { 'x-atlas-installation-id': installationId }),
    },
  });
}

/** A push token shaped like an FCM registration token (fake, never a real device). */
export function fakePushToken(label = 'device'): string {
  const random = Math.random().toString(36).slice(2);
  return `fake-${label}-${random}:APA91b${random}${random}`;
}
