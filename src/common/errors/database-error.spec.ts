import { domainErrorFromDatabase } from './database-error';

function pgError(message: string, code = 'P0001'): Error {
  return Object.assign(new Error(message), { code });
}

describe('domainErrorFromDatabase (API-100-05 AC3)', () => {
  it.each([
    ['invite_circle_member_by_phone', 'invite_circle_member_by_phone:circle_full'],
    ['create_circle_invite_link', 'create_circle_invite_link:circle_full'],
    ['resend_circle_invite', 'resend_circle_invite:circle_full'],
    ['accept_circle_invite', 'accept_circle_invite:circle_full'],
    ['complete_profile_setup', 'complete_profile_setup:circle_full'],
  ] as const)('raw circle_full in %s → %s (409)', (operation, code) => {
    const mapped = domainErrorFromDatabase(pgError('circle_full'), operation);
    expect(mapped?.code).toBe(code);
    expect(mapped?.status).toBe(409);
  });

  it('unwraps a wrapped driver error (cause chain)', () => {
    const wrapped = new Error('Failed query', {
      cause: new Error('inner', { cause: pgError('circle_full') }),
    });
    expect(domainErrorFromDatabase(wrapped, 'accept_circle_invite')?.code).toBe(
      'accept_circle_invite:circle_full',
    );
  });

  it('maps a prefixed `fn:code` message as-is', () => {
    expect(domainErrorFromDatabase(pgError('mark_incident_safe:not_open'), undefined)?.code).toBe(
      'mark_incident_safe:not_open',
    );
  });

  it('returns undefined without an operation, or when the operation has no such code', () => {
    expect(domainErrorFromDatabase(pgError('circle_full'), undefined)).toBeUndefined();
    expect(domainErrorFromDatabase(pgError('circle_full'), 'remove_circle_member')).toBeUndefined();
  });

  it('returns undefined for other SQLSTATEs, unknown messages and non-database errors', () => {
    expect(domainErrorFromDatabase(pgError('circle_full', '23505'), 'accept_circle_invite')).toBe(
      undefined,
    );
    expect(domainErrorFromDatabase(pgError('some_fn:unknown'), undefined)).toBeUndefined();
    expect(domainErrorFromDatabase(new Error('circle_full'), 'accept_circle_invite')).toBe(
      undefined,
    );
    expect(domainErrorFromDatabase('circle_full', 'accept_circle_invite')).toBeUndefined();
  });
});
