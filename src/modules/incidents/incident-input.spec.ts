import { DomainError } from '../../common/errors';
import {
  isPostgresText,
  isPostgresUuidInput,
  notesFromBody,
  requireIncidentId,
} from './incident-input';

/** `details.field` of the 422 `fn` throws. */
function fieldOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('validation:invalid_request');
    return (error as DomainError).details.field;
  }
  throw new Error('did not throw');
}

describe('incident request input (API-100-17/18)', () => {
  describe('isPostgresUuidInput: Postgres uuid_in grammar', () => {
    const base = 'a0eebc999c0b4ef8bb6d6bb9bd380a11';
    it.each([
      base,
      base.toUpperCase(),
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      `{${base}}`,
      'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11',
      'a0eebc99-9c0b4ef8-bb6d6bb9-bd380a11',
    ])('accepts %s', (value) => {
      expect(isPostgresUuidInput(value)).toBe(true);
    });

    it.each([
      '',
      'abc',
      `${base}-`,
      `-${base}`,
      `{${base}`,
      `${base}}`,
      ` ${base}`,
      `${base}0`,
      'a0eebc99--9c0b-4ef8-bb6d-6bb9bd380a11',
      'a0e-ebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      `g${base.slice(1)}`,
    ])('refuses %p', (value) => {
      expect(isPostgresUuidInput(value)).toBe(false);
    });

    it('refuses non-strings', () => {
      expect(isPostgresUuidInput(undefined)).toBe(false);
      expect(isPostgresUuidInput(42)).toBe(false);
    });
  });

  it('isPostgresText: no NUL, no unpaired surrogate', () => {
    expect(isPostgresText('plain \u{1F600} é')).toBe(true);
    expect(isPostgresText('a\u0000b')).toBe(false);
    expect(isPostgresText('\ud83d')).toBe(false);
    expect(isPostgresText('\ude00x')).toBe(false);
  });

  it('requireIncidentId: 422 on field id', () => {
    expect(() => requireIncidentId('nope')).toThrow(DomainError);
    try {
      requireIncidentId('nope');
    } catch (error) {
      expect((error as DomainError).details).toEqual({ field: 'id' });
    }
  });

  describe('notesFromBody', () => {
    it('missing and null are null; a string is kept as is (Postgres trims)', () => {
      expect(notesFromBody({})).toBeNull();
      expect(notesFromBody({ incident_notes: null })).toBeNull();
      expect(notesFromBody({ incident_notes: '  x  ' })).toBe('  x  ');
    });

    it.each([42, true, {}, [], 'a\u0000', '\ud800'])(
      'refuses %p on field incident_notes',
      (value) => {
        expect(fieldOf(() => notesFromBody({ incident_notes: value }))).toBe('incident_notes');
      },
    );

    it.each([null, [], 'x', undefined])('a body that is %p is refused on field body', (body) => {
      expect(fieldOf(() => notesFromBody(body))).toBe('body');
    });
  });
});
