import { DomainError } from '../../common/errors';
import { scrub } from '../../observability/scrubber';
import { sanitizeAuditDetail } from '../audit/audit.detail';
import {
  ALLERGIES,
  MEDICAL_CONDITIONS,
  MEDICAL_ITEM_MAX_LENGTH,
  MEDICAL_ITEMS_MAX,
  medicalItemTextFromBody,
} from './medical-items';

function failure(run: () => unknown): { code: string; field: unknown; status: number } {
  try {
    run();
  } catch (error) {
    const e = error as DomainError;
    return { code: e.code, field: e.details?.field, status: e.status };
  }
  throw new Error('expected a failure');
}

describe('medical item input (SCRUM-21, D51)', () => {
  it('limits: 1-100 characters, 20 items', () => {
    expect(MEDICAL_ITEM_MAX_LENGTH).toBe(100);
    expect(MEDICAL_ITEMS_MAX).toBe(20);
  });

  it('trims all whitespace (as the app) and keeps the text otherwise', () => {
    expect(medicalItemTextFromBody({ text: '  Peanuts \n' })).toBe('Peanuts');
    expect(medicalItemTextFromBody({ text: ' Penicillin　' })).toBe('Penicillin');
    expect(medicalItemTextFromBody({ text: 'x', other: 1 })).toBe('x');
  });

  it('exactly 100 characters (code points) pass; 101 fail', () => {
    expect(medicalItemTextFromBody({ text: 'a'.repeat(100) })).toHaveLength(100);
    expect(medicalItemTextFromBody({ text: '😀'.repeat(100) })).toHaveLength(200);
    expect(failure(() => medicalItemTextFromBody({ text: 'a'.repeat(101) }))).toEqual({
      code: 'profiles:invalid_medical_item',
      field: 'text',
      status: 422,
    });
  });

  it('blank → profiles:invalid_medical_item on text', () => {
    for (const text of ['', '   ', '\t\n']) {
      expect(failure(() => medicalItemTextFromBody({ text }))).toEqual({
        code: 'profiles:invalid_medical_item',
        field: 'text',
        status: 422,
      });
    }
  });

  it('missing, null, wrong type or a NUL character → validation:invalid_request on text', () => {
    for (const body of [{}, { text: null }, { text: 5 }, { text: ['a'] }, { text: 'a\u0000b' }]) {
      expect(failure(() => medicalItemTextFromBody(body))).toEqual({
        code: 'validation:invalid_request',
        field: 'text',
        status: 422,
      });
    }
    expect(failure(() => medicalItemTextFromBody('text')).code).toBe('validation:invalid_request');
  });

  it('the lists are distinct constants', () => {
    expect([ALLERGIES.table, MEDICAL_CONDITIONS.table]).toEqual([
      'profile_allergies',
      'profile_medical_conditions',
    ]);
    expect([ALLERGIES.itemsKey, MEDICAL_CONDITIONS.itemsKey]).toEqual([
      'allergy_items',
      'medical_condition_items',
    ]);
  });
});

describe('medical text never reaches logs or audit details (SCRUM-21)', () => {
  it('the log scrubber redacts the new keys', () => {
    const out = scrub({
      allergy_items: [{ id: 'x', text: 'Peanuts' }],
      medical_condition_items: [{ id: 'y', text: 'Asthma' }],
      live_share_payload: { allergies: ['Peanuts'] },
      share_payload_at_activation: { allergies: 'Peanuts' },
      share_payload: { medical_conditions: ['Asthma'] },
      allergies: 'Peanuts',
      medical_conditions: 'Asthma',
    });
    expect(JSON.stringify(out)).not.toMatch(/Peanuts|Asthma/);
  });

  it('an audit detail keeps the list name and id but never a text key', () => {
    const { detail, stripped } = sanitizeAuditDetail({
      list: 'allergies',
      item_id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
      allergies: 'Peanuts',
      medical_conditions: ['Asthma'],
      allergy_items: ['Peanuts'],
    });
    expect(detail).toEqual({ list: 'allergies', item_id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b' });
    expect(stripped).toEqual(['allergies', 'medical_conditions', 'allergy_items']);
  });
});
