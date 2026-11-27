import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import {
  avatarUrlBase,
  type AvatarUrlBase,
  type CapacityJson,
  type CircleMemberJson,
  CirclesRepository,
  type CirclesExecutor,
  type JoinedCircleJson,
  type SafetyCircleJson,
} from './circles.repository';

/** The body of `GET /v1/me/circle` (spec §11.3 C1). */
export interface OwnCircleJson {
  circle: SafetyCircleJson | null;
  members: CircleMemberJson[];
  capacity: CapacityJson | null;
}

/**
 * Circle reads (API-100-24, API-100-25): the owner's capacity (`circle_invite_capacity`), the
 * caller's own circle in one call (`safety_circles` SELECT + owner member list + capacity), and the
 * member list (`list_circle_members`). Read-only transactions in UTC; no row locks (the SQL functions
 * take none). Authorization: `circle.owner` and `circle.activeMember` (API-100-09).
 */
@Injectable()
export class CirclesService {
  private readonly avatars: AvatarUrlBase;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: CirclesRepository,
    config: ApiConfigService,
  ) {
    this.avatars = avatarUrlBase(config);
  }

  /**
   * `circle_invite_capacity()` (baseline 20261021120000; helper 20261117120000): the caller's owned
   * circle, else 403 `circle_invite_capacity:not_owner`. No location-sharing or profile check.
   */
  capacity(user: AuthenticatedUser): Promise<CapacityJson> {
    return this.read(async (tx) => {
      const owned = await this.repository.ownedCircle(tx, user.id);
      if (!owned) throw new DomainError('circle_invite_capacity:not_owner');
      return this.repository.capacity(tx, owned.id);
    });
  }

  /**
   * `GET /v1/me/circle`: `{circle, members (owner view), capacity}`, or `{circle: null, members: [],
   * capacity: null}` when the caller owns no circle. The three parts come from ONE snapshot
   * (`repeatable read`, one `now()`), so `members` and `capacity` always agree, also while an invite
   * is created or expires (a pending row counted in `capacity` is listed `pending`, an expired one
   * `expired`). No `invite_token` anywhere.
   */
  ownCircle(user: AuthenticatedUser): Promise<OwnCircleJson> {
    return this.read(async (tx) => {
      const owned = await this.repository.ownedCircle(tx, user.id);
      if (!owned) return { circle: null, members: [], capacity: null };
      const members = await this.repository.listMembers(tx, owned.id, true, this.avatars, user.id);
      const capacity = await this.repository.capacity(tx, owned.id);
      return { circle: owned.circle, members, capacity };
    });
  }

  /**
   * `list_circle_members(circle_id)` (final: baseline 20261117120000), checks in the function's
   * order: unknown circle → 404 `not_found`; caller neither the owner (`circle.owner`) nor an active
   * member (`circle.activeMember`) → 403 `not_authorized`. The owner gets every row (owner view);
   * an active member gets active rows only (member view).
   */
  members(user: AuthenticatedUser, circleId: string): Promise<CircleMemberJson[]> {
    return this.read(async (tx) => {
      const access = await this.repository.access(tx, circleId, user.id);
      if (!access.exists) throw new DomainError('list_circle_members:not_found');
      if (!access.is_owner && !access.is_active_member) {
        throw new DomainError('list_circle_members:not_authorized');
      }
      return this.repository.listMembers(tx, circleId, access.is_owner, this.avatars, user.id);
    });
  }

  /**
   * `list_my_joined_circles()` (final: baseline 20261021140000): the circles where the caller has an
   * active row, the own circle included (`role: owner`; parity, SCRUM-81 later excludes it). One
   * statement, as the `stable` function.
   */
  joinedCircles(user: AuthenticatedUser): Promise<JoinedCircleJson[]> {
    return this.read((tx) => this.repository.joinedCircles(tx, user.id));
  }

  private read<T>(query: (tx: CirclesExecutor) => Promise<T>): Promise<T> {
    return this.database.db.transaction(
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        return query(tx);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
