import { sql } from 'drizzle-orm';

import { definePolicy, type UuidOperand, uuidSql } from './policy';

/** `profile.self` (spec §11.4): caller id = profile id. Null on either side is false. */
export interface ProfileSelfArgs {
  profileId: UuidOperand;
  callerId: UuidOperand;
}

export const profileSelf = definePolicy<ProfileSelfArgs>(
  'profile.self',
  ({ profileId, callerId }) => sql`(${uuidSql(profileId)} = ${uuidSql(callerId)})`,
);

/** Pure form for values already in hand (uuids compared case-insensitively). */
export function isProfileSelf(profileId: string | null, callerId: string | null): boolean {
  return (
    profileId !== null && callerId !== null && profileId.toLowerCase() === callerId.toLowerCase()
  );
}
