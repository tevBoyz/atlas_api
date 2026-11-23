import { DomainError } from '../../common/errors';
import { invalidRequest, isPostgresText, requireJsonObject } from '../incidents/incident-input';
import { charLength } from './profile-input';

/**
 * SCRUM-21 (D51): the two medical lists of a profile. Each item is one row of its table; the old text
 * column of `profiles` is kept equal to the item texts joined with ", " (oldest first) so the old SQL
 * functions keep working. Names here are constants, never request data.
 */
export interface MedicalList {
  /** The list as the API names it (audit detail, route). */
  readonly name: 'allergies' | 'medical_conditions';
  /** The item table. */
  readonly table: 'profile_allergies' | 'profile_medical_conditions';
  /** The old `profiles` text column kept in sync. */
  readonly column: 'allergies' | 'medical_conditions';
  /** The Profile key of the items (`[{id, text, updated_at}]`, oldest first). */
  readonly itemsKey: 'allergy_items' | 'medical_condition_items';
}

export const ALLERGIES: MedicalList = {
  name: 'allergies',
  table: 'profile_allergies',
  column: 'allergies',
  itemsKey: 'allergy_items',
};

export const MEDICAL_CONDITIONS: MedicalList = {
  name: 'medical_conditions',
  table: 'profile_medical_conditions',
  column: 'medical_conditions',
  itemsKey: 'medical_condition_items',
};

export const MEDICAL_LISTS: readonly MedicalList[] = [ALLERGIES, MEDICAL_CONDITIONS];

/** Characters per item (`char_length`, code points), after trimming. */
export const MEDICAL_ITEM_MAX_LENGTH = 100;
/** Items per list. */
export const MEDICAL_ITEMS_MAX = 20;

/**
 * The body of add / edit: `{text}`. A missing key, null or a value of the wrong JSON type (or text
 * Postgres cannot hold) → 422 `validation:invalid_request` on `text`, as on every route; trimmed
 * with `trim()` (all whitespace, as the app's Dart `trim()`), then blank or longer than 100
 * characters → 422 `profiles:invalid_medical_item` on `text`. Other keys are ignored.
 */
export function medicalItemTextFromBody(raw: unknown): string {
  const body = requireJsonObject(raw);
  const value = body.text;
  if (typeof value !== 'string' || !isPostgresText(value)) throw invalidRequest('text');
  const text = value.trim();
  if (text.length === 0 || charLength(text) > MEDICAL_ITEM_MAX_LENGTH) {
    throw new DomainError('profiles:invalid_medical_item', { details: { field: 'text' } });
  }
  return text;
}
