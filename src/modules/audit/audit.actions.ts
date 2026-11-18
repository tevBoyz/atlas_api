/** The actions recorded in Epic 100 (API-100-14 AC3). `auth.*` actions arrive with Phase 6. */
export const AUDIT_ACTIONS = [
  'incident.created',
  'incident.renotified',
  'incident.notes_set',
  'incident.resolved',
  'incident.acknowledged',
  'circle.invite.created',
  'circle.invite.resent',
  'circle.invite.canceled',
  'circle.invite.accepted',
  'circle.invite.declined',
  'circle.member.removed',
  'circle.member.left',
  'profile.setup_completed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number] | `auth.${string}`;
