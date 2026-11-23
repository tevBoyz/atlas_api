/**
 * Authorization policies replacing RLS (API-100-09, spec §11.4). One rule per name, each a SQL
 * predicate (`where`, for lists) with a single-row form (`check` / `checkById`). See `policy.ts`.
 */
import { circleActiveMember, circleActiveMemberSince, circleOwner } from './circle.policies';
import { deliveryOwn } from './delivery.policies';
import {
  incidentCountsView,
  incidentEventsView,
  incidentMemberView,
  incidentResident,
} from './incident.policies';
import { inviteRecipient } from './invite.policies';
import { membershipActivate } from './membership.policies';
import { profileSelf } from './profile.policies';

export {
  circleActiveMember,
  circleActiveMemberSince,
  circleOwner,
  type CircleCallerArgs,
  type CircleWindowArgs,
} from './circle.policies';
export {
  type DeliveryArgs,
  deliveryOwn,
  type DeliveryPolicy,
  type DeliveryRef,
  INCIDENT_DELIVERIES_TABLE,
} from './delivery.policies';
export {
  incidentAlias,
  type IncidentArgs,
  incidentCountsView,
  incidentEventsView,
  incidentMemberView,
  type IncidentPolicy,
  type IncidentRef,
  incidentResident,
  INCIDENTS_TABLE,
  type NotFoundOperation,
  requireIncident,
} from './incident.policies';
export {
  type InviteMemberRef,
  inviteRecipient,
  type InviteRecipientArgs,
  type InviteRecipientPolicy,
  callerPhoneSql,
  isInviteRecipient,
  normalizeE164,
  normalizeE164Sql,
  SAFETY_CIRCLE_MEMBERS_TABLE,
} from './invite.policies';
export {
  ActivatedAtWriteError,
  assertNoActivatedAt,
  isMembershipActivationPath,
  MEMBERSHIP_ACTIVATION_PATHS,
  MEMBERSHIP_TABLE,
  membershipActivate,
  type MembershipActivatePolicy,
  type MembershipActivationPath,
  type MembershipMemberRef,
} from './membership.policies';
export {
  aliasColumn,
  definePolicy,
  evaluate,
  type Policy,
  type PolicyName,
  type SqlExecutor,
  type TextOperand,
  textSql,
  type TimestampOperand,
  timestampSql,
  type UuidOperand,
  uuidSql,
} from './policy';
export { isProfileSelf, profileSelf, type ProfileSelfArgs } from './profile.policies';

/** Every policy by its spec §11.4 name (API-100-09 AC1). */
export const POLICIES = {
  'profile.self': profileSelf,
  'circle.owner': circleOwner,
  'circle.activeMember': circleActiveMember,
  'circle.activeMemberSince': circleActiveMemberSince,
  'incident.resident': incidentResident,
  'incident.memberView': incidentMemberView,
  'incident.eventsView': incidentEventsView,
  'incident.countsView': incidentCountsView,
  'delivery.own': deliveryOwn,
  'invite.recipient': inviteRecipient,
  'membership.activate': membershipActivate,
} as const;
