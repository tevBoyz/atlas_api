import { Body, Controller, Delete, Headers, HttpCode, Put } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import {
  deviceRegistrationFromBody,
  INSTALLATION_ID_HEADER,
  requireInstallationId,
} from './device-input';
import {
  deviceRegisteredSchema,
  INSTALLATION_ID_HEADER_CONTRACT,
  registerDeviceRequestSchema,
} from './device.schemas';
import { DevicesService } from './devices.service';

/**
 * The caller's app installation (spec §11.3 U1/U2, API-100-44, D22). The installation is named by
 * the `X-Atlas-Installation-Id` header, never by a path id, so a caller can only ever touch their
 * own rows. Default authenticated rate limit; no Idempotency-Key (both routes are plain overwrites).
 */
@Controller('me/devices/current')
export class MeDevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** U1: after sign-in and whenever the push token changes. */
  @Put()
  @HttpCode(200)
  @Operation('user_devices')
  @ApiContract({
    operationId: 'registerCurrentDevice',
    summary: "Register this app installation and its push token for the caller's account",
    tag: 'devices',
    headers: [INSTALLATION_ID_HEADER_CONTRACT],
    body: { name: 'RegisterDeviceRequest', schema: registerDeviceRequestSchema },
    responses: {
      200: {
        description:
          'The installation is registered (created or updated; `last_seen_at` is now). Same `device_id` for the same user and installation.',
        name: 'DeviceRegistered',
        schema: deviceRegisteredSchema,
      },
    },
    errors: [
      'user_devices:invalid_installation_id',
      'validation:invalid_request',
      'user_devices:invalid_platform',
      'user_devices:invalid_app_version',
      'user_devices:invalid_push_provider',
      'user_devices:invalid_push_token',
    ],
  })
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
    @Body() body: unknown,
  ): Promise<{ device_id: string }> {
    const installation = requireInstallationId(installationId);
    return this.devices.register(user, installation, deviceRegistrationFromBody(body));
  }

  /** U2: at sign-out. 204 also when the installation has no token (or is unknown). */
  @Delete('push-token')
  @HttpCode(204)
  @Operation('user_devices')
  @ApiContract({
    operationId: 'clearCurrentDevicePushToken',
    summary: "Clear this installation's push token (sign-out)",
    tag: 'devices',
    headers: [INSTALLATION_ID_HEADER_CONTRACT],
    responses: {
      204: { description: 'No push token is stored for this installation any more.' },
    },
    errors: ['user_devices:invalid_installation_id'],
  })
  async clearPushToken(
    @CurrentUser() user: AuthenticatedUser,
    @Headers(INSTALLATION_ID_HEADER) installationId: unknown,
  ): Promise<void> {
    await this.devices.clearPushToken(user, requireInstallationId(installationId));
  }
}
