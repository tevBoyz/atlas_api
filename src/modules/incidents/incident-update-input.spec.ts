import { DomainError } from '../../common/errors';
import { STATUS_UPDATE_TEXT_MAX_LENGTH, statusUpdateFromBody } from './incident-update-input';

/** The 422 of a refused body: code, status and the field it names. */
function refusal(body: unknown): { code: string; status: number; field: unknown } {
  try {
    statusUpdateFromBody(body);
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    const error = err as DomainError;
    return { code: error.code, status: error.status, field: error.details.field };
  }
  throw new Error('the body was accepted');
}

const invalid = (field: string) => ({
  code: 'incident_updates:invalid_update',
  status: 422,
  field,
});

describe('statusUpdateFromBody (SCRUM-44/59, D70)', () => {
  it('accepts exactly one of the two presets', () => {
    expect(statusUpdateFromBody({ preset: 'situation_worsening' })).toEqual({
      preset: 'situation_worsening',
    });
    expect(statusUpdateFromBody({ preset: 'help_is_here' })).toEqual({ preset: 'help_is_here' });
  });

  it('accepts free text, trimmed, 1 to 250 characters (code points)', () => {
    expect(statusUpdateFromBody({ text: '  Door is locked\n' })).toEqual({
      text: 'Door is locked',
    });
    expect(statusUpdateFromBody({ text: 'x' })).toEqual({ text: 'x' });
    const max = 'a'.repeat(STATUS_UPDATE_TEXT_MAX_LENGTH);
    expect(statusUpdateFromBody({ text: ` ${max} ` })).toEqual({ text: max });
    // 250 emoji are 500 UTF-16 units but 250 characters.
    const emoji = '🚑'.repeat(STATUS_UPDATE_TEXT_MAX_LENGTH);
    expect(statusUpdateFromBody({ text: emoji })).toEqual({ text: emoji });
  });

  it('null counts as not given; unknown keys are ignored', () => {
    expect(statusUpdateFromBody({ preset: null, text: 'Hi' })).toEqual({ text: 'Hi' });
    expect(statusUpdateFromBody({ preset: 'help_is_here', text: null, extra: 1 })).toEqual({
      preset: 'help_is_here',
    });
  });

  it.each([
    ['null', null],
    ['an array', [{ preset: 'help_is_here' }]],
    ['a string', 'help_is_here'],
    ['an empty object', {}],
    ['both null', { preset: null, text: null }],
    ['both given', { preset: 'help_is_here', text: 'Hi' }],
  ])('refuses %s on field body', (_label, body) => {
    expect(refusal(body)).toEqual(invalid('body'));
  });

  it.each([
    ['an unknown preset', 'situation_better'],
    ['a preset in another case', 'Help_Is_Here'],
    ['a number', 1],
    ['an object', { value: 'help_is_here' }],
  ])('refuses %s on field preset', (_label, preset) => {
    expect(refusal({ preset })).toEqual(invalid('preset'));
  });

  it.each([
    ['empty', ''],
    ['only white space', ' \n\t '],
    ['251 characters', 'a'.repeat(STATUS_UPDATE_TEXT_MAX_LENGTH + 1)],
    ['251 emoji', '🚑'.repeat(STATUS_UPDATE_TEXT_MAX_LENGTH + 1)],
    ['a number', 42],
    ['a boolean', true],
    ['a NUL character', 'a\u0000b'],
    ['an unpaired surrogate', 'a\ud800b'],
  ])('refuses text that is %s on field text', (_label, text) => {
    expect(refusal({ text })).toEqual(invalid('text'));
  });

  it('never echoes the value in the error', () => {
    expect.assertions(1);
    try {
      statusUpdateFromBody({ text: 'x'.repeat(300) + 'SECRET-TEXT' });
    } catch (err) {
      expect(
        JSON.stringify({ message: (err as Error).message, details: (err as DomainError).details }),
      ).not.toContain('SECRET-TEXT');
    }
  });
});
