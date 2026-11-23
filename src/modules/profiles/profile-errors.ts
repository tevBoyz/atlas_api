import { DomainError, type ErrorCode } from '../../common/errors';

/**
 * The database error of a profile write as the right `profiles:*` code (API-100-35: a request never
 * ends in a 500 because of a table rule). The input parsers refuse every value these rules refuse,
 * so this is a backstop for a writer that changed the row in between, or a schema that changed.
 *
 * - 23514 (check violation): the constraint names the field (spec §4.2 constraint names);
 * - 23503 on `profiles_id_fkey`: the token's user has no `auth.users` row (deleted account) →
 *   `profiles:not_authenticated` (401), as an unknown user;
 * - 22007 / 22008 (date input): `profiles:invalid_date_of_birth`;
 * - 23505 on a medical list's `*_user_text_uidx` (SCRUM-21): `profiles:duplicate_medical_item`.
 * Anything else is unexpected (undefined → the caller rethrows → 500, logged without values).
 */
const CHECK_CONSTRAINTS: Readonly<Record<string, { code: ErrorCode; field: string }>> = {
  profiles_full_name_nonempty: { code: 'profiles:invalid_full_name', field: 'full_name' },
  profiles_gender_allowed: { code: 'profiles:invalid_gender', field: 'gender' },
  profiles_app_language_allowed: { code: 'profiles:invalid_app_language', field: 'app_language' },
  profiles_timezone_allowed: { code: 'profiles:invalid_timezone', field: 'timezone' },
  profiles_preferred_language_allowed: {
    code: 'profiles:invalid_preferred_language',
    field: 'preferred_language',
  },
  profiles_emergency_contact_relationship_allowed: {
    code: 'profiles:invalid_relationship',
    field: 'emergency_contact_relationship',
  },
  profiles_blood_type_allowed: { code: 'profiles:invalid_blood_type', field: 'blood_type' },
  profiles_emergency_notes_length: {
    code: 'profiles:emergency_notes_too_long',
    field: 'emergency_notes',
  },
};

/** The case-insensitive unique indexes of the medical lists (migration 0014). */
const DUPLICATE_ITEM_INDEXES: ReadonlySet<string> = new Set([
  'profile_allergies_user_text_uidx',
  'profile_medical_conditions_user_text_uidx',
]);

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
}

function pgError(error: unknown): PgErrorLike | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as PgErrorLike).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function profileWriteError(error: unknown): DomainError | undefined {
  const pg = pgError(error);
  if (!pg) return undefined;
  const constraint = typeof pg.constraint === 'string' ? pg.constraint : '';
  if (pg.code === '23514' && CHECK_CONSTRAINTS[constraint]) {
    const { code, field } = CHECK_CONSTRAINTS[constraint];
    return new DomainError(code, { details: { field }, cause: error });
  }
  if (pg.code === '23503' && constraint === 'profiles_id_fkey') {
    return new DomainError('profiles:not_authenticated', { cause: error });
  }
  if (pg.code === '23505' && DUPLICATE_ITEM_INDEXES.has(constraint)) {
    return new DomainError('profiles:duplicate_medical_item', {
      details: { field: 'text' },
      cause: error,
    });
  }
  if (pg.code === '22007' || pg.code === '22008') {
    return new DomainError('profiles:invalid_date_of_birth', {
      details: { field: 'date_of_birth' },
      cause: error,
    });
  }
  return undefined;
}

/**
 * A profile write that failed in the database for no known reason. Replaces the original error,
 * whose message or detail can carry a name, phone or medical text (a constraint's failing row), so
 * only the SQLSTATE reaches logs and error reports.
 */
export class ProfileWriteFailedError extends Error {
  constructor(readonly sqlState: string | undefined) {
    super('profile write failed in the database');
    this.name = 'ProfileWriteFailedError';
  }
}

export function sqlStateOfProfileError(error: unknown): string | undefined {
  const code = pgError(error)?.code;
  return typeof code === 'string' ? code : undefined;
}
