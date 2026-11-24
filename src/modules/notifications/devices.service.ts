import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { sqlStateOf } from '../incidents/incident-transaction';
import { type DeviceRegistration, type PushTokenStatus, pushTokenStatus } from './device-input';
import { type DeviceTransaction, DevicesRepository } from './devices.repository';

/** `auth.users` row missing: the token is valid but its user no longer exists (D16, D22). */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * A device write that failed in the database. It replaces the original error because a Drizzle
 * query error carries the statement's parameters, and those include the push token. Only the
 * SQLSTATE is kept.
 */
export class DeviceOperationFailedError extends Error {
  constructor(readonly sqlState: string | undefined) {
    super('user_devices write failed in the database');
    this.name = 'DeviceOperationFailedError';
  }
}

/** The U1 answer (D22, D69). */
export interface DeviceRegistered {
  device_id: string;
  push_token_status: PushTokenStatus;
}

/**
 * Device registration (API-100-44, spec §11.3 U1/U2, D22). Works with Supabase access tokens: the
 * device belongs to the token's user, no own session is needed. Not audited (no audit action covers
 * it; the push token must never reach `audit_log`).
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: DevicesRepository,
  ) {}

  /** U1. Returns `{device_id, push_token_status}` (D69). */
  async register(
    user: AuthenticatedUser,
    installationId: string,
    input: DeviceRegistration,
  ): Promise<DeviceRegistered> {
    const outcome = await this.run(async (tx) => {
      const written = await this.repository.register(tx, user.id, installationId, input);
      // Own sessions (API-100-56): sign-out of this session clears this device's push token.
      if (user.issuer === 'atlas' && user.sessionId) {
        await this.repository.linkSession(tx, user.id, user.sessionId, written.id);
      }
      return written;
    });
    return { device_id: outcome.id, push_token_status: pushTokenStatus(outcome) };
  }

  /** U2. Idempotent: nothing to clear is fine too. */
  async clearPushToken(user: AuthenticatedUser, installationId: string): Promise<void> {
    await this.run((tx) => this.repository.clearPushToken(tx, user.id, installationId));
  }

  private async run<T>(work: (tx: DeviceTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.database.db.transaction((tx) => work(tx));
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (sqlState === FOREIGN_KEY_VIOLATION) {
        throw new DomainError('user_devices:not_authenticated');
      }
      throw new DeviceOperationFailedError(sqlState);
    }
  }
}
