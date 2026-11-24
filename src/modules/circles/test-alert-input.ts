import { invalidRequest, isPostgresUuidInput } from '../incidents/incident-input';

/** The `{id}` path parameter of a test-alert route (SCRUM-35): valid uuid input, else 422 on `id`. */
export function requireTestAlertId(value: unknown): string {
  if (!isPostgresUuidInput(value)) throw invalidRequest('id');
  return value;
}
