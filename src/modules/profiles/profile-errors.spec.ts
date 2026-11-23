import { DomainError } from '../../common/errors';
import {
  ProfileWriteFailedError,
  profileWriteError,
  sqlStateOfProfileError,
} from './profile-errors';

/** A node-postgres error, wrapped the way Drizzle wraps it. */
function pgError(code: string, constraint?: string): Error {
  const inner = Object.assign(new Error('failing row contains (secret values)'), {
    code,
    constraint,
  });
  return new Error('Failed query', { cause: inner });
}

describe('profile write errors (API-100-35: never a 500 for a table rule)', () => {
  it.each([
    ['profiles_full_name_nonempty', 'profiles:invalid_full_name', 'full_name'],
    ['profiles_gender_allowed', 'profiles:invalid_gender', 'gender'],
    ['profiles_app_language_allowed', 'profiles:invalid_app_language', 'app_language'],
    ['profiles_timezone_allowed', 'profiles:invalid_timezone', 'timezone'],
    [
      'profiles_preferred_language_allowed',
      'profiles:invalid_preferred_language',
      'preferred_language',
    ],
    [
      'profiles_emergency_contact_relationship_allowed',
      'profiles:invalid_relationship',
      'emergency_contact_relationship',
    ],
    ['profiles_blood_type_allowed', 'profiles:invalid_blood_type', 'blood_type'],
    ['profiles_emergency_notes_length', 'profiles:emergency_notes_too_long', 'emergency_notes'],
  ])('check %s → %s', (constraint, code, field) => {
    const mapped = profileWriteError(pgError('23514', constraint));
    expect(mapped).toBeInstanceOf(DomainError);
    expect(mapped?.code).toBe(code);
    expect(mapped?.status).toBe(422);
    expect(mapped?.details).toEqual({ field });
  });

  it('a deleted account (profiles_id_fkey) → 401 profiles:not_authenticated', () => {
    expect(profileWriteError(pgError('23503', 'profiles_id_fkey'))?.code).toBe(
      'profiles:not_authenticated',
    );
  });

  it.each(['profile_allergies_user_text_uidx', 'profile_medical_conditions_user_text_uidx'])(
    'a duplicate item (%s, SCRUM-21) → 409 profiles:duplicate_medical_item',
    (index) => {
      const mapped = profileWriteError(pgError('23505', index));
      expect(mapped?.code).toBe('profiles:duplicate_medical_item');
      expect(mapped?.status).toBe(409);
      expect(mapped?.details).toEqual({ field: 'text' });
    },
  );

  it('another unique violation is not mapped', () => {
    expect(profileWriteError(pgError('23505', 'profiles_pkey'))).toBeUndefined();
  });

  it('date input errors → profiles:invalid_date_of_birth', () => {
    expect(profileWriteError(pgError('22008'))?.code).toBe('profiles:invalid_date_of_birth');
    expect(profileWriteError(pgError('22007'))?.code).toBe('profiles:invalid_date_of_birth');
  });

  it('anything else is not mapped; the replacement error carries the SQLSTATE only', () => {
    const error = pgError('40001');
    expect(profileWriteError(error)).toBeUndefined();
    expect(profileWriteError(new Error('no code'))).toBeUndefined();
    expect(profileWriteError(pgError('23514', 'some_other_check'))).toBeUndefined();
    const replaced = new ProfileWriteFailedError(sqlStateOfProfileError(error));
    expect(replaced.sqlState).toBe('40001');
    expect(replaced.message).not.toMatch(/secret/);
  });
});
