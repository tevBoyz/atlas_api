/**
 * The actions recorded in Epic 100 (API-100-14 AC3). `auth.*` actions: Phase 6 (API-100-52 to 59)
 * and stage 7.1 (`auth.password.changed`, A16; `auth.phone.changed`, A18).
 */
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
  // SCRUM-21 (D51): detail {list, item_id} only, never the text.
  'profile.medical_item.added',
  'profile.medical_item.updated',
  'profile.medical_item.deleted',
  'auth.signup',
  'auth.email_verified',
  'auth.phone_verified',
  'auth.login.success',
  'auth.login.failure',
  'auth.identity.linked',
  'auth.refresh.reuse_detected',
  'auth.logout',
  'auth.logout_all',
  'auth.session.revoked',
  'auth.password.reset',
  'auth.session.exchanged',
  'auth.password.changed',
  'auth.phone.changed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number] | `auth.${string}`;
